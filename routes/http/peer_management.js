var http = require('http');
var url = require('url');
var async = require('async');
var getBody = require('./../../utils/get_body');
var getTenantId = require('./../../utils/get_tenant_id');
var sirenResponse = require('./../../utils/siren_response');
var parseUri = require('./../../utils/parse_uri');
var statusCode = require('./../../utils/status_code');

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

      self._proxyReq(request, response, parsed, serverUrl);
    });
  } else {
    // HTTP POST|PUT|DELETE /peer-management/<connection_id> - Locate in all active targets

    // Find the target with the connection id
    this._locateConnectionIdTarget(tenantId, lookupId, function(err, serverUrl) {
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

      self._proxyReq(request, response, parsed, serverUrl);
    });
  }
};

PeerManagement.prototype._locateConnectionIdTarget = function(tenantId, connectionId, cb) {
  var self = this;
  var servers = this.proxy.activeTargets(tenantId);

  var pending = [];
  async.detectLimit(servers, 5, function locateConnectionId(server, next) {
    var parsed = url.parse(server.url);
    parsed.pathname = '/peer-management';
    
    var req = http.get(url.format(parsed), function(res) {
      if (res.statusCode !== 200) {
        return next(false);
      }

      getBody(res, function(err, body) {
        if (err) {
          return next(false);
        }
        var json = null;
        try {
          json = JSON.parse(body.toString());
        } catch (err) {
          return next(false);
        }

        if (!Array.isArray(json.entities)) {
          return next(false);
        }
        
        var found = json.entities.some(function(entity) {
          return (entity.properties.connectionId === connectionId);
        });

        next(found);
      });
    });

    req.setTimeout(10000);
    req.on('error', function(err) {
      next(false);
    });
    pending.push(req);
  }, function(server) {
    pending.forEach(function(req) {
      req.abort();
    });
    return cb(null, (server) ? server.url : null);
  });
};

PeerManagement.prototype._proxyReq = function(request, response, parsed, serverUrl) {
  var server = url.parse(serverUrl);
  var options = {
    method: request.method,
    headers: request.headers,
    hostname: server.hostname,
    port: server.port,
    path: parsed.path
  };

  var target = http.request(options);
  target.on('response', function(targetResponse) {
    response.statusCode = targetResponse.statusCode;
    Object.keys(targetResponse.headers).forEach(function(header) {
      response.setHeader(header, targetResponse.headers[header]);
    });
    targetResponse.pipe(response);
  });

  target.on('error', function() {
    response.statusCode = 500;
    response.end();
  });

  request.pipe(target);
};

PeerManagement.prototype.serveRoot = function(request, response, parsed) {
  var self = this;
  var tenantId = getTenantId(request);

  var servers = this.proxy.activeTargets(tenantId).map(function(server) { 
    return url.parse(server.url);
  });
  
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

  if (servers.length === 0) {
    sirenResponse(response, 200, body);
    return;
  }

  var pending = [];
  response.on('close', function() {
    pending.forEach(function(req) {
      req.abort();
    });
  });

  async.mapLimit(servers, 5, function(server, next) {
    var options = {
      method: request.method,
      headers: request.headers,
      hostname: server.hostname,
      port: server.port,
      path: parsed.path
    };

    var target = http.request(options);
    pending.push(target);
    target.on('response', function(targetResponse) {
      getBody(targetResponse, function(err, body) {
        if (err) {
          return next(null, { err: err });
        }
        var json = null;
        try {
          json = JSON.parse(body.toString());
        } catch (err) {
          return next(null, { err: err });
        }

        next(null, { res: targetResponse, json: json } );
      });
    });

    target.on('error', function(err) {
      next(null, { err: err });
    });

    target.end();
  }, function(err, results) {
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



