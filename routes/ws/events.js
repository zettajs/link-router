var http = require('http');
var url = require('url');
var getTenantId = require('./../../utils/get_tenant_id');
var confirmWs = require('./../../utils/confirm_ws');

function parseSubscription(hash) {
  var arr = hash.split(':');
  return {
    tenantId: decodeURIComponent(arr[0]),
    targetName: decodeURIComponent(arr[1]),
    targetHost: decodeURIComponent(arr[2]),
    url: decodeURIComponent(arr[3])
  };
}

var Events = module.exports = function(proxy) {
  var self = this;
  this.proxy = proxy;
  this._cache = {};
  this._subscriptions = {};

  this.proxy.on('router-update', function(results) {
    self._disconnectStaleWsClients();
  });

  setInterval(function() {
    var wsCounts = {};
    Object.keys(self._subscriptions).forEach(function(topicHash) {
      var parsed = parseSubscription(topicHash);
      if (!wsCounts[parsed.tenantId]) {
        wsCounts[parsed.tenantId] = 0;
      }
      wsCounts[parsed.tenantId]++;
    });
    Object.keys(wsCounts).forEach(function(tenant) {
      self.proxy._statsClient.gauge('ws.event', wsCounts[tenant], { tenant: tenant });
    });

  }, 5000);
};

Events.prototype.handler = function(request, socket, receiver) {
  var self = this;
  var parsed = url.parse(request.url, true);
  var targetName;
  var tenantId = getTenantId(request);

  var match = /^\/servers\/(.+)$/.exec(request.url);
  if (match) {
    targetName = decodeURIComponent(/^\/servers\/(.+)$/.exec(parsed.pathname)[1].split('/')[0]);
  } else {
    self.proxy._statsClient.increment('http.req.event.status.4xx', { tenant: tenantId });
    var responseLine = 'HTTP/1.1 404 Server Not Found\r\n\r\n\r\n';
    socket.end(responseLine);
    return;
  }

  this.proxy.lookupPeersTarget(tenantId, targetName, function(err, serverUrl) {
    if (err) {
      self.proxy._statsClient.increment('http.req.event.status.5xx', { tenant: tenantId });
      var responseLine = 'HTTP/1.1 500 Internal Server Error\r\n\r\n\r\n';
      socket.end(responseLine);
      return;
    }

    if (!serverUrl) {
      self.proxy._statsClient.increment('http.req.event.status.4xx', { tenant: tenantId });
      var responseLine = 'HTTP/1.1 404 Server Not Found\r\n\r\n\r\n';
      socket.end(responseLine);
      return;
    }

    var urlHash = [tenantId, targetName, serverUrl, request.url].map(encodeURIComponent).join(':');
    if (!self._subscriptions.hasOwnProperty(urlHash)) {
      self._subscriptions[urlHash] = [];
    }

    socket.on('error', function(err) {
      console.error('Client Socket Error:', tenantId, targetName, err);
    });

    function removeSocketFromCache() {
      var idx = self._subscriptions[urlHash].indexOf(socket);
      if (idx >= 0) {
        self._subscriptions[urlHash].splice(idx, 1);
      }
      
      if (self._subscriptions[urlHash].length === 0) {
        if (self._cache[urlHash]) {
          self._cache[urlHash].end();
        }
        delete self._subscriptions[urlHash];
        delete self._cache[urlHash];
      }
    }

    var cleanup = function() {};

    socket.on('close', function() {
      cleanup();
    });

    if (self._cache.hasOwnProperty(urlHash)) {
      confirmWs(request, socket);
      self._subscriptions[urlHash].push(socket);
      self.proxy._statsClient.increment('http.req.event.status.1xx', { tenant: tenantId });
      cleanup = function() {
        removeSocketFromCache();
      };

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

    cleanup = function () {
      target.abort();
    };

    target.on('upgrade', function(targetResponse, upgradeSocket, upgradeHead) {
      var code = targetResponse.statusCode;
      var responseLine = 'HTTP/1.1 ' + code + ' ' + http.STATUS_CODES[code];
      var headers = Object.keys(targetResponse.headers).map(function(header) {
        return header + ': ' + targetResponse.headers[header];
      });

      self.proxy._statsClient.increment('http.req.event.status.1xx', { tenant: tenantId });
      socket.write(responseLine + '\r\n' + headers.join('\r\n') + '\r\n\r\n');

      self._cache[urlHash] = upgradeSocket;
      self._subscriptions[urlHash].push(socket);

      cleanup = function() {
        removeSocketFromCache();
      };

      upgradeSocket.on('data', function(data) {
        if (self._subscriptions[urlHash]) {
          self._subscriptions[urlHash].forEach(function(socket) {
            socket.write(data);
          });
        }
      });

      upgradeSocket.on('close', function() {
        delete self._cache[urlHash];
        if (self._subscriptions[urlHash]) {
          self._subscriptions[urlHash].forEach(function(socket) {
            socket.end();
          });
        }
      });

      upgradeSocket.on('error', function(err) {
        console.error('Target Ws Socket Error:', tenantId, targetName, err);
      });
    });

    target.on('error', function() {
      var responseLine = 'HTTP/1.1 500 Internal Server Error\r\n\r\n\r\n';
      socket.end(responseLine);
    });

    request.pipe(target);
  });
};

// disconnects client ws where the hub no longer exists or 
// exists on a different target server
Events.prototype._disconnectStaleWsClients = function() {
  var self = this;

  // make sure target exists in router and is the same as what is subscribed to
  Object.keys(this._cache).forEach(function(hash) {
    var obj = parseSubscription(hash);
    var serverUrl = self.proxy._routerCache.get(obj.tenantId, obj.targetName);
    if (serverUrl === undefined || serverUrl !== obj.targetHost) {
      // end subscription to zetta target, will close all clients
      self._cache[hash].end();
    }
  });
};
