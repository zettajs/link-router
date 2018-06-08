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



