// Copyright 2018 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

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

RouterCache.prototype.del = function(tenantId, targetName) {
  var key = this._hash(tenantId, targetName);
  return this.cache.del(key);
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


