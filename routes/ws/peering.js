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

var url = require('url');
var path = require('path');
var http = require('http');
var jwt = require('jsonwebtoken');
var getTenantId = require('./../../utils/get_tenant_id');
var getBody = require('../../utils/get_body');

var Peering = module.exports = function(proxy) {
  this._proxy = proxy;
  this.jwtTokenLifeSec = 60; // seconds
};

Peering.prototype.handler = function(request, socket) {
  var self = this;
  var tenantId = getTenantId(request);

  var parsed = url.parse(this._proxy._tenantMgmtApi);
  var options = {
    hostname: parsed.hostname,
    port: parsed.port,
    method: 'POST',
    path: path.join('/tenants',  tenantId, 'target')
  };
  
  var req = http.request(options, function(response) {
    // Rewrite Location to include original request path and JWT
    if (response.headers.location) {
      var serverUrlParsed = url.parse(response.headers.location);
      var requestParsed = url.parse(request.url, true);
      requestParsed.host = serverUrlParsed.host;
      requestParsed.port = serverUrlParsed.port;
      requestParsed.protocol = serverUrlParsed.protocol;
      delete requestParsed.search;


      if (self._proxy.jwtPlaintextKeys) {
        var token = { tenantId: tenantId, location: response.headers.location };
        requestParsed.query.jwt = jwt.sign(token, self._proxy.jwtPlaintextKeys.external, { expiresIn: self.jwtTokenLifeSec }); // jwt access token
      }

      response.headers.location = url.format(requestParsed);
    }

    var code = response.statusCode;
    var responseLine = 'HTTP/1.1 ' + code + ' ' + http.STATUS_CODES[code];
    var headers = Object.keys(response.headers).map(function(header) {
      return header + ': ' + response.headers[header];
    });
    
    socket.write(responseLine + '\r\n' + headers.join('\r\n') + '\r\n\r\n');
    response.pipe(socket);
  });

  req.once('error', function(err) {
    socket.end('HTTP/1.1 500 Server Error\r\n\r\n\r\n');
  });

  req.end();
};
