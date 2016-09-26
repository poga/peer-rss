const hyperdrive = require('hyperdrive')
const FeedParser = require('feedparser')
const memdb = require('memdb')
const toStream = require('string-to-stream')
const async = require('async')
const Feed = require('feed')
const toString = require('stream-to-string')
const swarm = require('hyperdrive-archive-swarm')
const request = require('request')
const moment = require('moment')

function Torrent (key, opts) {
  if (!(this instanceof Torrent)) return new Torrent(opts)

  if (typeof key === 'object' && !Buffer.isBuffer(key) && key) {
    opts = key
    key = null
  }
  if (!opts) opts = {}
  if (!opts.storage) opts.storage = memdb()
  this.scrap = opts.scrap
  this._drive = hyperdrive(opts.storage)
  if (key) {
    this._archive = this._drive.createArchive(key)
    this.own = false
  } else {
    this._archive = this._drive.createArchive()
    this.own = true
  }
}

Torrent.prototype.key = function () {
  return this._archive.key
}

Torrent.prototype.swarm = function () {
  return swarm(this._archive)
}

Torrent.prototype.update = function (feed) {
  var torrent = this
  return new Promise((resolve, reject) => {
    if (!this.own) return reject(new Error("can't update archive you don't own"))
    var feedparser = new FeedParser()
    toStream(feed).pipe(feedparser)

    var tasks = []
    feedparser.on('error', e => reject(e))
    feedparser.on('meta', meta => {
      this.meta = meta

      tasks.push((cb) => {
        var ws = torrent._archive.createFileWriteStream('_meta')
        toStream(JSON.stringify(meta)).pipe(ws).on('finish', cb)
      })
    })
    feedparser.on('readable', function () {
      var readable = this
      var entry

      while (entry = readable.read()) {
        tasks.push(torrent._save(entry))
        if (torrent.scrap) tasks.push(torrent._scrap(entry))
      }
    })
    feedparser.on('end', function () {
      async.series(tasks, (err, results) => {
        if (err) return reject(err)
        resolve(torrent)
      })
    })
  })
}

Torrent.prototype.setMeta = function (meta) {
  var torrent = this
  torrent.meta = meta

  return new Promise((resolve, reject) => {
    var ws = torrent._archive.createFileWriteStream('_meta')
    toStream(JSON.stringify(meta)).pipe(ws).on('finish', () => { resolve(torrent) })
  })
}

Torrent.prototype.push = function (entry) {
  return new Promise((resolve, reject) => {
    var tasks = []

    tasks.push(this._save(entry))
    if (this.scrap) tasks.push(this._scrap(entry))

    async.series(tasks, (err, results) => {
      if (err) return reject(new Error('archive failed'))
      resolve(this)
    })
  })
}

Torrent.prototype.list = function (opts, cb) {
  if (typeof opts === 'function') {
    cb = opts
    opts = {}
  }

  if (this.own) {
    this._archive.finalize(() => {
      this._archive.list(opts, done)
    })
  } else {
    this._archive.list(opts, done)
  }

  function done (err, results) {
    if (err) return cb(err)

    cb(null, results.filter(x => { return x.name !== '_meta' }))
  }
}

Torrent.prototype.xml = function (count) {
  return new Promise((resolve, reject) => {
    this.list((err, entries) => {
      if (err) return reject(err)
      if (entries.length > count) {
        entries = entries.sort(byCTimeDESC).slice(0, 10)
      }

      buildXML(this._archive, this.meta, entries).then(xml => resolve(xml))
    })
  })
}

Torrent.prototype._save = function (entry) {
  return (cb) => {
    this.list((err, entries) => {
      if (err) return cb(err)
      if (entries.find(x => x.name === entry.guid)) return cb() // ignore duplicated entry
      if (!entry.guid) return cb(new Error('GUID not found'))

      toStream(JSON.stringify(entry)).pipe(this._createWriteStream(entry)).on('finish', cb)
    })
  }
}

Torrent.prototype._scrap = function (entry) {
  return (cb) => {
    request(entry.url, (err, resp, body) => {
      if (err) return cb(err)
      if (resp.statusCode !== 200) return cb(new Error('invalid status code'))

      toStream(body).pipe(this._createWriteStream(entry)).on('finish', cb)
    })
  }
}

Torrent.prototype._createWriteStream = function (entry) {
  return this._archive.createFileWriteStream({
    name: entry.guid,
    ctime: entry.date ? entry.date.getTime() : 0
  })
}

module.exports = Torrent

function buildXML (archive, meta, entries) {
  return new Promise((resolve, reject) => {
    var feed = new Feed(Object.assign(meta, {feed_url: meta.xmlUrl, site_url: meta.link}))
    var tasks = []
    entries.forEach(e => {
      tasks.push(load(archive, e))
    })

    async.parallel(tasks, (err, results) => {
      if (err) return reject(err)
      results.forEach(r => feed.addItem(r))
      resolve(feed.render('rss-2.0'))
    })
  })
}

function byCTimeDESC (x, y) {
  return y.ctime - x.ctime
}

function load (archive, entry) {
  return (cb) => {
    var rs = archive.createFileReadStream(entry)
    toString(rs, (err, str) => {
      if (err) return cb(err)

      var item = JSON.parse(str)
      item.date = moment(item.date).toDate()
      cb(null, item)
    })
  }
}
