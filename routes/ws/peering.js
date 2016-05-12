var url = require('url');
var http = require('http');
var getTenantId = require('./../../utils/get_tenant_id');

var Peering = module.exports = function(proxy) {
  var self = this;
  this.proxy = proxy;
  this._peerSockets = [];

  setInterval(function() {
    var counts = {};
    self._peerSockets.forEach(function(peerObj) {
      if (!counts[peerObj.tenantId]) {
        counts[peerObj.tenantId] = 0;
      }
      counts[peerObj.tenantId]++;
    });

    Object.keys(counts).forEach(function(tenant) {
      self.proxy._statsClient.gauge('ws.peers', counts[tenant], { tenant: tenant });
    });
  }, 5000);

  ['SIGINT', 'SIGTERM'].forEach(function(signal) {
    process.on(signal, function() {
      
      var count = proxy._peerSockets.length;
      self._peerSockets.forEach(function(peer) {
        self.proxy._routerClient.remove(peer.tenantId, peer.targetName, function() {
          count--;
          if (count === 0) {
            process.exit();
          }
        })
      });
      
      if (count === 0) {
        process.exit();
      }

    });
  });

};

Peering.prototype.handler = function(request, socket) {
  var self = this;
  var parsed = url.parse(request.url, true);
  var targetName;
  var tenantId = getTenantId(request);

  var match = /^\/peers\/(.+)$/.exec(request.url);
  if (match) {
    targetName = decodeURIComponent(/^\/peers\/(.+)$/.exec(parsed.pathname)[1]);
  }

  socket.on('error', function(err) {
    console.error('Peer Socket Error:', tenantId, targetName, err);
  });

  self.proxy._statsClient.increment('http.req.peer', { tenant: tenantId });

  this.proxy._routerClient.get(tenantId, targetName, function(err, peer) {
    if (err && (!err.error || err.error.errorCode !== 100) ) {
      socket.end('HTTP/1.1 500 Server Error\r\n\r\n\r\n');
      self.proxy._statsClient.increment('http.req.peer.status.5xx', { tenant: tenantId });
      return;
    }
    
    if (peer) {
      socket.end('HTTP/1.1 409 Peer Conflict\r\n\r\n\r\n');
      self.proxy._statsClient.increment('http.req.peer.status.4xx', { tenant: tenantId });
      return;
    }
    
    self._next(tenantId, function(err, serverUrl) {
      if(err) {
        console.error('Peer Socket Failed to allocated target:', err);
        socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n\r\n');
        self.proxy._statsClient.increment('http.req.peer.status.5xx', { tenant: tenantId });
        return;
      }

      if (!serverUrl) {
        socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n\r\n');
        self.proxy._statsClient.increment('http.req.peer.status.5xx', { tenant: tenantId });
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

      // Handle non 101 responses from target
      target.on('response', function(targetResponse) {
        var code = targetResponse.statusCode;
        var responseLine = 'HTTP/1.1 ' + code + ' ' + http.STATUS_CODES[code];
        var headers = Object.keys(targetResponse.headers).map(function(header) {
          return header + ': ' + targetResponse.headers[header];
        });

        socket.write(responseLine + '\r\n' + headers.join('\r\n') + '\r\n\r\n');
        targetResponse.pipe(socket);
      });
      
      target.on('upgrade', function(targetResponse, upgradeSocket, upgradeHead) {
        var timer = null;
        var code = targetResponse.statusCode;
        var peerObj = { tenantId: tenantId,
                        targetName: targetName,
                        upgradeSocket: upgradeSocket,
                        socket: socket
                      };

        var cleanup = function() {
          clearInterval(timer);          
          var idx = self._peerSockets.indexOf(peerObj);
          if (idx >= 0) {
            self._peerSockets.splice(idx, 1);
          }
          self.proxy._routerClient.remove(tenantId, targetName, function(err) {}); 
        };

        self.proxy._statsClient.increment('http.req.peer.status.1xx', { tenant: tenantId });

        var responseLine = 'HTTP/1.1 ' + code + ' ' + http.STATUS_CODES[code];
        var headers = Object.keys(targetResponse.headers).map(function(header) {
          return header + ': ' + targetResponse.headers[header];
        });

        upgradeSocket.on('error', function(err) {
          console.error('Target Socket Error:', tenantId, targetName, err);
          cleanup();
        });
        upgradeSocket.on('timeout', function() {
          console.error('Target Socket Timeout:', tenantId, targetName);
          upgradeSocket.destroy();
          socket.end();
        });
        upgradeSocket.setTimeout(self.proxy.peerActivityTimeout);

        socket.write(responseLine + '\r\n' + headers.join('\r\n') + '\r\n\r\n');
        upgradeSocket.pipe(socket).pipe(upgradeSocket);

        socket.on('close', cleanup);
        upgradeSocket.on('close', cleanup);

        if (code === 101) {
          self._peerSockets.push(peerObj);
          self.proxy._routerClient.add(tenantId, targetName, serverUrl, function(err) {});
          timer = setInterval(function() {
            self.proxy._routerClient.add(tenantId, targetName, serverUrl, function(err) {});
          }, 60000);
        } else {
          socket.end();
        }
      });

      target.on('error', function() {
        var responseLine = 'HTTP/1.1 500 Internal Server Error\r\n\r\n\r\n';
        socket.end(responseLine);
        self.proxy._statsClient.increment('http.req.peer.status.5xx', { tenant: tenantId });
      });

      request.pipe(target);
    });

  });

};

Peering.prototype._next = function(tenantId, cb) {
  var self = this;
  return this.proxy._targetAllocation.lookup(tenantId, cb);
}

