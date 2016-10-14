var LRU = require('lru-cache');

var RootCache = module.exports = function(opts) {
  opts = opts || {};
  var options = {
    maxAge: opts.maxAge || (2 * 1000),
    max: opts.max || Infinity
  };

  this.cache = new LRU(options);
};

RootCache.prototype.get = function(tenantId) {
  var key = this._hash(tenantId);
  return this.cache.get(key);
};

RootCache.prototype.del = function(tenantId) {
  var key = this._hash(tenantId);
  return this.cache.del(key);
};

RootCache.prototype.set = function(tenantId, peers) {
  var key = this._hash(tenantId);
  return this.cache.set(key, peers);
};
// clear cache
RootCache.prototype.reset = function() {
  return this.cache.reset();
};

RootCache.prototype._hash = function(tenantId) {
  return tenantId;
};



