var http = require('http');
var url = require('url');
var async = require('async');
var caql = require('caql');
var Rels = require('zetta-rels');
var parseUri = require('./../../utils/parse_uri');
var getBody = require('./../../utils/get_body');
var getTenantId = require('./../../utils/get_tenant_id');
var statusCode = require('./../../utils/status_code');
var sirenResponse = require('./../../utils/siren_response');

var Handler = module.exports = function(proxy) {
  this.name = 'query'; // for stats logging
  this.proxy = proxy;
};

Handler.prototype.handler = function(request, response, parsed) {
  var self = this;

  try {
    caql.parse(parsed.query.ql);
  } catch (err) {
    sirenResponse(response, 400, this._buildQueryError(request, err));
    return;
  }
  
  if (parsed.query.server === '*') {
    return this._crossServerQueryReq.apply(this, arguments);
  }

  var tenantId = getTenantId(request);
  var targetName = parsed.query.server;
  
  // Set targetname for stats
  request._targetName = targetName;

  var body = this._buildQueryResult(request);

  this.proxy.lookupPeersTarget(tenantId, targetName, function(err, serverUrl) {
    if (err) {
      sirenResponse(response, 200, body);
      return;
    }

    self.proxy.proxyToTarget(serverUrl, request, response);
  });
};


Handler.prototype._crossServerQueryReq = function(request, response, parsed) {
  var self = this;
  var tenantId = getTenantId(request);
  var body = this._buildQueryResult(request);

  var servers = this.proxy.activeTargets(tenantId).map(function(server) { 
    return url.parse(server.url);
  });

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
    var includes = results.filter(function(ret) { return !ret.err && ret.res.statusCode === 200 && ret.json; })

    includes.forEach(function(ret) {
      body.entities = body.entities.concat(ret.json.entities);
    });

    sirenResponse(response, 200, body);
  });
};

Handler.prototype._buildQueryError = function(request, err) {
  return {
    class: ['query-error'],
    properties: {
      message: err.message
    },
    links: [
      { rel: ['self'], href: parseUri(request) }
    ]
  };
};

Handler.prototype._buildQueryResult = function(request) {
  var selfLink = parseUri(request);
  var parsed = url.parse(selfLink, true);
  var wsLink = url.format({ 
    host: parsed.host,
    slashes: true,
    protocol: (parsed.protocol === 'http:') ? 'ws' : 'wss',
    pathname: '/events',
    query: {
      topic: 'query/' + parsed.query.ql,
      since: new Date().getTime()
    }
  });

  return {
    class: ['root', 'search-results'],
    properties: {
      server: parsed.query.server,
      ql: parsed.query.ql
    },
    entities: [],
    links: [
      { rel: ['self'], href: selfLink },
      { rel: [Rels.query], href: wsLink }
    ]
  };
};
