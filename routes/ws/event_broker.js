var util = require('util');
var EventEmitter = require('events').EventEmitter;
var WebSocket = require('ws');

var EventBroker = module.exports = function(proxy) {
  var self = this;
  
  this.proxy = proxy;

  // { <tenantId>: [EventSocket, ...] }
  this._clients = {};

  // { <tenantId>: { <targetUrl>: TargetConnection }
  this._targetConnections = {};

  this.proxy.on('services-update', function(results) {
    Object.keys(self._clients).forEach(function(tenantId) {
      self._connectToTargets(tenantId);
    });
  });

  // Check target connections every 5s incase of a missed service update
  setInterval(function() {
    Object.keys(self._clients).forEach(function(tenantId) {
      self._connectToTargets(tenantId);
    });
  }, 5000);

};

// Add client when it connectes
EventBroker.prototype.client = function(socket) {
  var self = this;

  if (this._clients[socket.tenantId] === undefined) {
    this._clients[socket.tenantId] = [];
  }

  // scope clients to tenantId
  var clients = this._clients[socket.tenantId];
  clients.push(socket);
  
  // Ensure connections to targets are ready
  this._connectToTargets(socket.tenantId);

  // Handle subscriptions on connection
  // TODO...
  
  // Handle subscriptions after connect
  socket.on('subscribe', function(subscription) {
    self._subscribe(socket, subscription);
  });

  socket.on('unsubscribe', function(subscription) {
    self._unsubscribe(socket, subscription);
  });

  // Client closed
  socket.once('close', function() {
    var idx = clients.indexOf(socket);
    if (idx >= 0) {
      clients.splice(idx, 1);
    }

    // Unsubscribe from subscriptions
    var connections = self._targetConnections[socket.tenantId];
    Object.keys(connections).forEach(function(serverUrl) {
      socket._subscriptions.forEach(function(subscription) {
        connections[serverUrl].unsubscribe(subscription);
      });
    });

  });
};

EventBroker.prototype._subscribe = function(socket, subscription) {
  // Subscribe to targets
  var connections = this._targetConnections[socket.tenantId];
  if (!connections) {
    return;
  }
  Object.keys(connections).forEach(function(serverUrl) {
    var targetConn = connections[serverUrl];
    targetConn.subscribe(subscription);
  });
};

EventBroker.prototype._unsubscribe = function(socket, subscription) {
  // Subscribe to targets
  var connections = this._targetConnections[socket.tenantId];
  if (!connections) {
    return;
  }
  Object.keys(connections).forEach(function(serverUrl) {
    var targetConn = connections[serverUrl];
    targetConn.unsubscribe(subscription);
  });
};

EventBroker.prototype._onTargetData = function(tenantId, msg) {
  // Distribute to clients
  var clients = this._clients[tenantId];
  if (!clients) {
    return;
  }

  clients.forEach(function(client) {
    // Check all subscriptions and send for each subscription it matches on
    client.checkAndSend(msg);
  });
};

EventBroker.prototype._connectToTargets = function(tenantId) {
  var self = this;
  if(this._targetConnections[tenantId] === undefined) {
    this._targetConnections[tenantId] = {};
  }
  
  var connections = this._targetConnections[tenantId];
  var activeServers = this.proxy.activeTargets(tenantId);

  // Disconnect any targets that are not active
  Object.keys(connections).forEach(function(serverUrl) {
    // If target is not in the active servers disconnect
    if (!activeServers.some(function(server) { return server.url === serverUrl; })) {
      console.error('Disconnect non valid target', serverUrl);
      connections[serverUrl].close();
    }
  });

  activeServers.forEach(function(server) {
    if (connections[server.url] === undefined) {
      connections[server.url] = new TargetConnection(server.url, self.proxy);
      var onDataHandler = function(msg) {
        self._onTargetData(tenantId, msg);
      };
      connections[server.url].on('message', onDataHandler);
      
      connections[server.url].once('close', function(err) {
        connections[server.url].removeListener('message', onDataHandler);
        console.error('TargetConnection to ', server.url, 'closed with: ', err);
        // Remove from connections
        delete connections[server.url];
      });

      // Sync clients subscriptions to TargetConnection
      var clients = self._clients[tenantId];
      if (!clients) {
        return;
      }

      clients.forEach(function(client) {
        client._subscriptions.forEach(function(subscription) {
          connections[server.url].subscribe(subscription);
        });
      });
    }
  });
};

EventBroker.prototype._disconnectClients = function(tenantId) {
  var clients = this._clients[tenantId];
  if (!clients) {
    return;
  }

  clients.forEach(function(client) {
    client.close();
  });
};

function TargetConnection(targetUrl, proxy) {
  EventEmitter.call(this);

  this.proxy = proxy;
  
  this.url = targetUrl;

  // Mapping between internal subscription id and zetta returned subscriptionId
  this._subscriptions = {}; // { <subscription._id>: <subscriptionId> }

  // List of subscriptions awaiting ws to be opened to target
  this._pendingSubscriptions = [];

  this._subscriptionsList = [];
  
  this._conn = null;

  this._metricsInterval = null;
  this._metrics = {
    packets: 0,
    bytes: 0,
    subscriptions: 0
  };

  this._init();
}
util.inherits(TargetConnection, EventEmitter);


TargetConnection.prototype._init = function() {
  var self = this;
  var socketOptions = {
    headers: {
      'host': 'link.iot.apigee.net'
    }
  };

  this.proxy.addTokenToReqOptions(socketOptions, this.url);
   
  this._conn = new WebSocket(this.url.replace('http:', 'ws:') + '/events?filterMultiple=true', null, socketOptions);
  this._conn.once('open', function() {
    // Subscribe to pending subscriptions
    self._pendingSubscriptions.forEach(function(subscription, idx, arr) {
      self.subscribe(subscription);
    });
    self._pendingSubscriptions = [];

    self.proxy._statsClient.increment('ws.target.connect', { targetUrl: self.url });

    // record data rate metrics every 10 sec
    self._metricsInterval = setInterval(function() {
      self.proxy._statsClient.gauge('ws.target.packets', self._metrics.packets, { targetUrl: self.url });
      self.proxy._statsClient.gauge('ws.target.bytes', self._metrics.bytes, { targetUrl: self.url });
      self.proxy._statsClient.gauge('ws.target.subscriptions', self._metrics.subscriptions, { targetUrl: self.url });
    }, 10000);
  });

  this._conn.once('close', function() {
    self.emit('close');
    clearInterval(self._metricsInterval);
    self.proxy._statsClient.increment('ws.target.close', { targetUrl: self.url });
  });

  this._conn.once('error', function(err) {
    clearInterval(self._metricsInterval);
    self.proxy._statsClient.increment('ws.target.close', { targetUrl: self.url });
    self.emit('close', err);
  });

  this._conn.on('message', function(data, flags) {
    self._metrics.packets++;
    self._metrics.bytes+=data.length;

    try {
      data = JSON.parse(data);
    } catch (err) {
      console.error('TargetConnection ERROR:', err);
      return;
    }

    if (data.type === 'subscribe-ack') {
      var subscription = self._subscriptionsList.shift();
      if (!subscription) {
        return;
      }
      self._subscriptions[subscription._id] = data.subscriptionId;
      self._metrics.subscriptions++;
    } else if(data.type === 'event') {
      self.emit('message', data);
    } else if (data.type === 'unsubscribe-ack') {
    } else {
      console.error('TargetConnection ERROR: Received non subscribe-ack or event from zetta.', data);
    }
  });
};

TargetConnection.prototype.close = function() {
  self._conn.close();
};

TargetConnection.prototype.subscribe = function(subscription) {
  var self = this;
  // If not connected to ws add to pending
  if (this._conn.readyState !== WebSocket.OPEN) {
    this._pendingSubscriptions.push(subscription);
    return;
  }

  // Create new subscription without limit or query
  var msg = {
    type: 'subscribe',
    topic: subscription.topic._seperateStreamQuery(subscription.topic._original).topic
  };

  this._conn.send(JSON.stringify(msg), function(err) {
    if (err) {
      console.error('TargetConnection: Send error.', err);
    }
    // Add to list awaiting to be peered with a `subscription-ack`;
    self._subscriptionsList.push(subscription);
  });
};

TargetConnection.prototype.unsubscribe = function(subscription) {
  var self = this;

  if (!this._subscriptions[subscription._id]) {
    return;
  }

  var msg = {
    type: 'unsubscribe',
    subscriptionId: this._subscriptions[subscription._id]
  };

  this._conn.send(JSON.stringify(msg), function(err) {
    if (err) {
      console.error('TargetConnection: Send error.', err);
    }

    delete self._subscriptions[subscription._id];
    self._metrics.subscriptions--;
  });  
};



