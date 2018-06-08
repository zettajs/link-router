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
var url = require('url');
var Rels = require('zetta-rels');
var getTenantId = require('./../../utils/get_tenant_id');
var sirenResponse = require('./../../utils/siren_response');
var parseUri = require('./../../utils/parse_uri');
var joinUri = require('./../../utils/join_uri');
var statusCode = require('./../../utils/status_code');

var TargetProxy = module.exports = function(proxy) {
  this.name = 'proxy'; // for stats logging
  this.proxy = proxy;
};

TargetProxy.prototype.handler = function(request, response, parsed) {
  var self = this;
  var targetName;
  var tenantId = getTenantId(request);

  var match = /^\/servers\/(.+)$/.exec(request.url);
  if (match) {
    targetName = decodeURIComponent(/^\/servers\/(.+)$/.exec(parsed.pathname)[1].split('/')[0]);
  } else {
    response.statusCode = 404;
    response.end();
    return;
  }
  
  self.proxy.lookupPeersTarget(tenantId, targetName, function(err, serverUrl) {
    if (err) {
      response.statusCode = 404;
      response.end();
      return;
    }

    // Set targetname for stats
    request._targetName = targetName;

    self.proxy.proxyToTarget(serverUrl, request, response);
  });
};
