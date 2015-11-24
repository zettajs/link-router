var LRU = require('lru-cache');

var RouterCache = module.exports = function(opts) {
  opts = opts || {};
  var options = {
    maxAge: opts.maxAge || (60 * 1000),
    max: opts.max || Infinity
  };

  this.cache = new LRU(options);
};

RouterCache.prototype.get = function(tenantId, targetName) {
  var key = this._hash(tenantId, targetName);
  return this.cache.get(key);
};

RouterCache.prototype.set = function(tenantId, targetName, serverUrl) {
  var key = this._hash(tenantId, targetName);
  return this.cache.set(key, serverUrl);
};

// Return a list of keys <tenantId>/<targetName> for a given tenantId.
// If no tenantId is given return all keys.
RouterCache.prototype.keys = function(tenantId) {
  var keys = this.cache.keys();
  if (tenantId) {
    tenantId = encodeURIComponent(tenantId);
    keys = keys.filter(function(key) {
      return key.indexOf(tenantId + '/') === 0;
    });
  }

  return keys.map(this._split);
};

// clear cache
RouterCache.prototype.reset = function() {
  return this.cache.reset();
};

RouterCache.prototype._hash = function(tenantId, targetName) {
  tenantId = encodeURIComponent(tenantId);
  targetName = encodeURIComponent(targetName);
  return tenantId + '/' + targetName;
};

RouterCache.prototype._split = function(key) {
  var idx = key.indexOf('/');
  return { tenantId: decodeURIComponent(key.substring(0, idx)), targetName: decodeURIComponent(key.substring(idx+1)) };
};


