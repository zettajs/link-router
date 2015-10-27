var url = require('url');
var http = require('http');
var async = require('async');
var caql = require('caql');
var ws = require('ws');
var getBody = require('./get_body');
var getTenantId = require('./get_tenant_id');
var confirmWs = require('./confirm_ws');
var EventStreamsParser = require('./zetta-tmp/event_streams_parser')
var StreamTopic = require('./zetta-tmp/stream_topic');
var JSCompiler = require('caql-js-compiler');

var Handler = module.exports = function(proxy) {
  this.proxy = proxy;
  this._cache = {};
  this._queryCache = {};
};

Handler.prototype.connection = function(request, socket, wsReceiver) {
  var self = this;
  var tenantId = getTenantId(request);
  var cache = this._getCacheObj(tenantId, request, socket);

//  self.proxy._statsClient.increment('http.req.wsquery.status.1xx', { tenant: tenantId });
  socket.on('error', function(err) {
    console.error('Ws Event Stream Error:', tenantId, err);
  });

  cache.wsSender.on('error', function(err) {
    console.error('ws sender error:', err);
  })

  // cleanup backend connections to target
  socket.on('close', function() {
    cache.pending.forEach(function(wsSocket) {
      wsSocket.terminate();
    });
    
    Object.keys(cache.targets).forEach(function(targetUrl) {
      // guard against clients closing before upgrade event is sent
      if (cache.targets[targetUrl] && cache.targets[targetUrl].terminate) {
        cache.targets[targetUrl].terminate();
      }
    });

    self.proxy.removeListener('services-update', handleNewTargets);
    
    cache.remove();
  });

  var servers = this.proxy.activeTargets(tenantId);
  confirmWs(request, socket);

  var handleNewTargets = function() {
    self.proxy.activeTargets(tenantId).forEach(function(server) {
      if (!cache.targets.hasOwnProperty(server.url)) {
        self._subscribeToTarget(cache, server);
      }
    });
  };

  self.proxy.on('services-update', handleNewTargets);

  servers.forEach(function(server) {
    self._subscribeToTarget(cache, server);
  });
 
  var parser = new EventStreamsParser();
  parser.on('error', function(err, original) {
    var msg = {
      type: 'error',
      code: 400,
      timestamp: new Date().getTime(),
      topic: (typeof original === 'object') ? original.topic : null,
      message: err.message
    };
    cache.wsSender.send(JSON.stringify(msg));
  });

  parser.on('subscribe', function(msg) {
    var topic = new StreamTopic();
    try {
      topic.parse(msg.topic);
    } catch(err) {
      var msg = {
        type: 'error',
        code: 400,
        timestamp: new Date().getTime(),
        topic: msg.topic,
        message: err.message
      };
      cache.wsSender.send(JSON.stringify(msg));
      return;
    }

    if(topic.streamQuery && !self._queryCache[topic.streamQuery]) {
      try {
        var compiler = new JSCompiler();
        var compiled = compiler.compile(topic.streamQuery);
        self._queryCache[topic.streamQuery] = compiled;
      } catch(err) {
        var msg = {
          type: 'error', 
          code: 400,
          timestamp: new Date().getTime(),
          topic: msg.topic,
          message: err.message  
        }
        cache.wsSender.send(JSON.stringify(msg));
        return;
      }
    }

    var subscription = { subscriptionId: ++cache.subscriptionIndex, topic: topic, limit: msg.limit };
    
    cache.subscribe(subscription);

    // subscribe to targets

    var msg = {
      type: 'subscribe-ack',
      timestamp: new Date().getTime(),
      topic: msg.topic,
      subscriptionId: subscription.subscriptionId
    };
    cache.wsSender.send(JSON.stringify(msg));
  });

  parser.on('unsubscribe', function(msg) {
    var foundIdx = -1;
    cache.subscriptions.some(function(subscription, idx) {
      if(subscription.linkSubscription.subscriptionId === msg.subscriptionId) {
        foundIdx = idx;
        return true;
      }
    });

    if (foundIdx < 0) {
      var msg = {
        type: 'error',
        code: 405,
        timestamp: new Date().getTime(),
        message: (new Error('Unable to unsubscribe from invalid subscriptionId')).message
      };
      cache.wsSender.send(JSON.stringify(msg));
      return;
    }

    var subscription = cache.subscriptions.splice(foundIdx, 1)[0];
    var msg = {
      type: 'unsubscribe-ack',
      timestamp: new Date().getTime(),
      subscriptionId: subscription.linkSubscription.subscriptionId
    };


    // unsubscribe from targets

    cache.wsSender.send(JSON.stringify(msg));
  });

  wsReceiver.ontext = function(data) {
    parser.add(data);
  };
};

Handler.prototype._subscribeToTarget = function(cache, target) {
  var server = url.parse(target.url);
  var request = cache.clientRequest;
  var parsed = url.parse(request.url);
  var options = {
    method: request.method,
    headers: request.headers,
    hostname: server.hostname,
    port: server.port,
    path: parsed.path
  };


  var wsSocket = new ws(target.url.replace('http:', 'ws:') + '/events');
  cache.targets[target.url] = null;

  cache.pending.push(wsSocket);

  function removeFromPending() {
    var idx = cache.pending.indexOf(wsSocket);
    if (idx >= 0) {
      cache.pending.splice(idx, 1);
    }    
  }

  wsSocket.on('open', function() {
    removeFromPending();
    cache.targets[target.url] = wsSocket;

    // send current subscriptions
    cache.subscriptions.forEach(function(subscription) {
      console.log(subscription)
    });
  });

  wsSocket.on('error', function(err) {
    console.error('Event Stream Target Ws Error:', target.url, err);
  });

  wsSocket.on('close', function(code, message) {
    delete cache.targets[target.url];
    cache.clientSocket.end();
  });

  wsSocket.on('message', function(data) {});
};

Handler.prototype._getCacheObj = function(tenantId, request, socket) {
  var self = this;
  if (!this._cache[tenantId]) {
    this._cache[tenantId] = [];
  }
  
  var cacheObj = null;
  var found = this._cache[tenantId].some(function(obj) {
    if (obj.clientSocket === socket) {
      cacheObj = obj;
      return true;
    }
    return false;
  });

  if (!found) {
    var obj = {
      clientSocket: socket,
      clientRequest: request,
      wsSender: new ws.Sender(socket),
      targets: {}, // <targetUrl>: socket
      pending: [], // list of pending http req assoc to this query
      subscriptionIndex: 0,
      subscriptions: [], // { linkSubscription: subscription, targetSu }
      subscribe: function(subscription) {
        obj.subscriptions.push({ linkSubscription: subscription, targetSubscriptions: {} });
      },
      unsubscribe: function(subscription) {},
      remove: function() {
        var idx = self._cache[tenantId].indexOf(obj);
        if (idx >= 0) {
          self._cache[tenantId].splice(idx, 1);
        }
      }
    };

    this._cache[tenantId].push(obj);
    return obj;
  } else {
    return cacheObj;
  }
};

