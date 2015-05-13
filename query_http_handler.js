var http = require('http');
var url = require('url');
var async = require('async');
var caql = require('caql');
var parseUri = require('./parse_uri');
var getBody = require('./get_body');
var getTenantId = require('./get_tenant_id');

var Handler = module.exports = function(proxy) {
  this.proxy = proxy;
};

Handler.prototype.serverQuery = function(request, response, parsed) {
  var self = this;

  if (parsed.query.server === '*') {
    return this._crossServerQueryReq.apply(this, arguments);
  }

  var tenantId = getTenantId(request);
  var targetName = parsed.query.server;

  try {
    caql.parse(parsed.query.ql);
  } catch (err) {
    var body = this._buildQueryError(request, err);
    response.statusCode = 400;
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.end(JSON.stringify(body));
    return;    
  }

  var body = this._buildQueryResult(request);

  this.proxy.lookupPeersTarget(tenantId, targetName, function(err, serverUrl) {
    if (err) {
      response.setHeader('Access-Control-Allow-Origin', '*');
      response.end(JSON.stringify(body));
      return;
    }

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
  });
};


Handler.prototype._crossServerQueryReq = function(request, response, parsed) {
  var self = this;
  var tenantId = getTenantId(request);

  try {
    caql.parse(parsed.query.ql);
  } catch (err) {
    var body = this._buildQueryError(request, err);
    response.statusCode = 400;
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.end(JSON.stringify(body));
    return;    
  }

  var body = this._buildQueryResult(request);

  var servers = this.proxy.activeTargets(tenantId).map(function(server) { 
    return url.parse(server.url);
  });

  if (servers.length === 0) {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.end(JSON.stringify(body));
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

    response.setHeader('Access-Control-Allow-Origin', '*');
    response.end(JSON.stringify(body));
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
      { rel: ['http://rels.zettajs.io/query'], href: wsLink }
    ]
  };
};
