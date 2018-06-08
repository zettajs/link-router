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
var getTenantId = require('./../../utils/get_tenant_id');
var sirenResponse = require('./../../utils/siren_response');
var parseUri = require('./../../utils/parse_uri');

var PeerManagement = module.exports = function(proxy) {
  this.name = 'peer-management'; // for stats logging
  this.proxy = proxy;
};

PeerManagement.prototype.handler = function(request, response, parsed) {
  if (!(/^\/peer-management\/(.+)$/.exec(request.url))) {
    // only allow GET on the root
    if (request.method !== 'GET') {
      response.statusCode = 405;
      response.end();
      return;
    }
    this.serveRoot(request, response, parsed);
  } else {
    this.proxyReq(request, response, parsed);
  }
};

PeerManagement.prototype.proxyReq = function(request, response, parsed) {
  var self = this;
  var tenantId = getTenantId(request);

  // Can either be hub_name or a connection id
  var lookupId = decodeURIComponent(/^\/peer-management\/(.+)$/.exec(parsed.pathname)[1]);
  

  // HTTP GET /peer-managment/<hub_name> - Lookup etcd
  if (request.method === 'GET') {
    // lookup target by hub_name
    this.proxy.lookupPeersTarget(tenantId, lookupId, function(err, serverUrl) {
      if (err) {
        response.statusCode = 404;
        response.end();
        return;
      }

      self.proxy.proxyToTarget(serverUrl, request, response);
    });
  } else {
    // HTTP POST|PUT|DELETE /peer-management/<connection_id> - Locate in all active targets

    // Find the target with the connection id
    this._locateConnectionIdTarget(tenantId, request, lookupId, function(err, serverUrl) {
      if (err) {
        response.statusCode = 500;
        response.end();
        return;
      }

      if (!serverUrl) {
        response.statusCode = 404;
        response.end();
        return;
      }

      self.proxy.proxyToTarget(serverUrl, request, response);
    });
  }
};

PeerManagement.prototype._locateConnectionIdTarget = function(tenantId, request, connectionId, cb) {
  var options = {
    method: 'GET',
    path: '/peer-management',
    headers: {},
    timeout: 10000
  };
  
  this.proxy.scatterGatherActive(tenantId, request, options, function(err, results) {
    if (err) {
      return cb(err);
    }

    var found = results.some(function(ret) {
      if (ret.err || ret.res.statusCode !== 200 || !ret.json) {
        return false;
      }
      
      if (!Array.isArray(ret.json.entities)) {
        return false;
      }

      return ret.json.entities.some(function(entity) {
        if (entity.properties.connectionId === connectionId) {
          cb(null, ret.server);
          return true;
        }
      });
    });

    if (!found) {
      return cb(null, null);
    }
  });
};

PeerManagement.prototype.serveRoot = function(request, response, parsed) {
  var self = this;
  var tenantId = getTenantId(request);
  
  var selfLink = parseUri(request);
  var parsed = url.parse(selfLink, true);
  var wsLink = url.format({ 
    host: parsed.host,
    slashes: true,
    protocol: (parsed.protocol === 'http:') ? 'ws' : 'wss',
    pathname: parsed.pathname,
  });

  var body = {
    class: ['peer-management'],
    actions: [],
    entities: [],
    links: [
      { rel: ['self'], href: selfLink },
      { rel: ['monitor'], href: wsLink }
    ]
  };

  self.proxy.scatterGatherActive(tenantId, request, function(err, results) {
    if (err) {
      response.statusCode = 500;
      response.end();
      return;
    }

    // include only 200 status code responses
    var includes = results.filter(function(ret) { return !ret.err && ret.res.statusCode === 200 && ret.json; });

    includes.forEach(function(ret) {
      if (Array.isArray(ret.json.entities)) {
        var filtered = ret.json.entities.filter(function(entity) {
          return entity.properties.status === 'connected';
        });
        body.entities = body.entities.concat(filtered);
      }
    });
    
    sirenResponse(response, 200, body);
  });
};

