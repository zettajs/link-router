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

var http = require('http');

var TenantMgmtApi = module.exports = function(etcd) {
  this._etcd = etcd;
  this._server = http.createServer(this.onRequest.bind(this));
};

TenantMgmtApi.prototype.href = function() {
  return 'http://localhost:' + this._server.address().port;
};

TenantMgmtApi.prototype.listen = function() {
  this._server.listen.apply(this._server, arguments);
};

TenantMgmtApi.prototype.onRequest = function(request, response) {
  var self = this;
  var targetCount = 2;
  var tenantId  = /\/tenants\/(.+)\/target$/.exec(request.url)[1];

  this._etcd.get('/zetta/version', { recursive: true }, function(err, results) {
    var version = JSON.parse(results.node.value).version;
    self._etcd.get('/services/zetta', { recursive: true }, function(err, results) {

      if (results.node.nodes) {
        var nodes = results.node.nodes.map(function(node) {
          node.value = JSON.parse(node.value);
          return node;
        });
      } else {
        var nodes = [];
      }
      
      var allocated = nodes.filter(function(node) {
        return node.value.tenantId === tenantId && node.value.version === version;
      });

      var unallocated = nodes.filter(function(node) {
        return !node.value.tenantId && node.value.version === version;
      });


      while (allocated.length < targetCount && unallocated.length > 0) {
        var node = unallocated.pop();
        node.value.tenantId = tenantId;
        self._etcd.set(node.key, JSON.stringify(node.value));
        self._etcd._trigger('/services/zetta', []);
        
        allocated.push(node);
      }

      if (allocated.length === 0) {
        response.statusCode = 503;
        response.end();
        return;
      }

      response.statusCode = 302;
      response.setHeader('Location', allocated[0].value.url);
      response.end();
    });
  });
};

