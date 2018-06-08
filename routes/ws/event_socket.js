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

var util = require('util');
var EventEmitter = require('events').EventEmitter;
var ws = require('ws');
var uuid = require('node-uuid');
var EventStreamsParser = require('zetta-events-stream-protocol').Parser;
var StreamTopic = require('zetta-events-stream-protocol').StreamTopic;
var JSCompiler = require('caql-js-compiler');
var confirmWs = require('./../../utils/confirm_ws');
var getTenantId = require('./../../utils/get_tenant_id');

var EventSocket = module.exports = function(request,
                                            socket,
                                            wsReceiver,
                                            options) {
  EventEmitter.call(this);

  if (options === undefined) {
    options = {};
  }

  // Flags
  this.streamEnabled = !!(options.streamEnabled);  
  this.tenantId = getTenantId(request);
  
  this.request = request;
  this.socket = socket;
  this.wsReceiver = wsReceiver;
  this.wsSender = new ws.Sender(this.socket);
  
  // list of event streams
  this._subscriptions = [];
  this._subscriptionIndex = 0;
  // list of topics to initial subscribe to with non multiplexed ws
  this._queries = options.queries || []; // contains [{ name: <peerName>, topic: <topic> }]

  this._request = request;

  this.init();
};
util.inherits(EventSocket, EventEmitter);

EventSocket.prototype.onClose = function() {
  this.emit('close');
};

EventSocket.prototype.checkAndSend = function(msg) {
  var self = this;
  this._subscriptions.forEach(function(subscription) {
    // Check if topic matches subscription
    if (!subscription.topic.match(msg.topic)) {
      return;
    }

    // Check if streamEnabled client

    var newMsg = {};
    newMsg.type = 'event';
    newMsg.topic = msg.topic;
    newMsg.timestamp = msg.timestamp;
    // Use one sent to client originally
    newMsg.subscriptionId = subscription.subscriptionId;

    if (msg.data !== undefined) {
      newMsg.data = msg.data;
    } else {
      // handle device and server /logs stream
      newMsg.data = {};
      var filtered = ['topic', 'timestamp'];
      Object.keys(msg)
        .filter(function(key) { return filtered.indexOf(key) === -1; })
        .forEach(function(key) {
          newMsg.data[key] = msg[key];
        })
    }


    // handle caql query

    if (subscription.compiledQuery) {
      var compiled = subscription.compiledQuery;
      var result = compiled.filterOne({ data: newMsg.data });
      if (result) {
        newMsg.data = result[Object.keys(result)[0]];
      } else {
        return;
      }
    }
    
    // handle limits
    subscription.count++;
    if (typeof subscription.limit === 'number' && subscription.count > subscription.limit) {
      self.emit('unsubscribe', subscription);
      self._unsubscribe(subscription.subscriptionId);
      return;
    }

    self.send(newMsg);
  });
};

EventSocket.prototype.send = function(msg) {

  // Rewrite msg for old style
  if (!this.streamEnabled) {
    delete msg.subscriptionId;
    delete msg.type;
    var topic = new StreamTopic();
    topic.parse(msg.topic);
    msg.topic = (topic.isSpecial) ? topic._original : topic._pubsubIdentifier;
    // 
    if (!msg.timestamp) {
      msg.timestamp = new Date().getTime();
    }

    var propertiesForDevice = ['class', 'properties', 'links', 'actions'];
    var isDeviceQueryMsg = propertiesForDevice.every(function(k) {
      return msg.data[k] !== undefined; 
    });

    // For device query messages device is at root of message
    if (isDeviceQueryMsg) {
      msg = msg.data;
    }
  }

  
  var str = JSON.stringify(msg);
  if (this._request.headers.host) {
    var host = this._request.headers['host'];
    var protocol = this._request.headers['x-forwarded-proto'] || 'http';
    str = str.replace('http://link.iot.apigee.net', protocol + '://' + host);
  }

  this._write(str);
};

EventSocket.prototype._write = function(str) {
  this.wsSender.send(new Buffer(str));
};

EventSocket.prototype.init = function() {
  var self = this;

  // only setup parser when using event stream
  if (this.streamEnabled) {
    this._parser = new EventStreamsParser();
    this._parser.on('error', function(err, original) {
      var msg = {
        type: 'error',
        code: (err.name === 'InvalidTypeError') ? 405 : 400,
        timestamp: new Date().getTime(),
        topic: (typeof original === 'object') ? original.topic : null,
        message: err.message
      };
      self._write(JSON.stringify(msg));
    });

    this._parser.on('ping', function(msg) {
      var msg = {
        type: 'pong',
        timestamp: new Date().getTime(),
        data: msg.data
      };
      self._write(JSON.stringify(msg));
    });

    this._parser.on('subscribe', function(msg) {
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
        self._write(JSON.stringify(msg));
        return;
      }

      if (topic.pubsubIdentifier() === '') {
        var msg = {
          type: 'error',
          code: 400,
          timestamp: new Date().getTime(),
          topic: msg.topic,
          message: 'Topic must have server and specific topic. Specific topic missing.'
        };
        self._write(JSON.stringify(msg));
        return;
      }

      var compiled = null;
      if (topic.streamQuery) {
        try {
          var compiler = new JSCompiler();
          compiled = compiler.compile(topic.streamQuery);
        } catch(err) {
          var msg = {
            type: 'error', 
            code: 400,
            timestamp: new Date().getTime(),
            topic: msg.topic,
            message: err.message  
          }
          self._write(JSON.stringify(msg));
          return;
        }
      }

      var subscription = {
        subscriptionId: ++self._subscriptionIndex,
        topic: topic,
        limit: msg.limit,
        compiledQuery: compiled,
        count: 0
      };

      // Set internal ID
      subscription._id = uuid.v4();

      self._subscriptions.push(subscription);

      var msg = {
        type: 'subscribe-ack',
        timestamp: new Date().getTime(),
        topic: msg.topic,
        subscriptionId: subscription.subscriptionId
      };
      
      self._write(JSON.stringify(msg));
      self.emit('subscribe', subscription);
    });

    this._parser.on('unsubscribe', function(msg) {
      self._unsubscribe(msg.subscriptionId, function(err, subscription) {
        if (subscription) { 
          self.emit('unsubscribe', subscription.subscriptionId);
        }
      });
    });
  }
  
  this.socket.once('close', this.onClose.bind(this));
  this.socket.once('error',function(err){
    self.onClose();
  });

  this.wsReceiver.ontext = function(data) {
    if (self.streamEnabled) {
      self._parser.add(data);
    }
  };
};

EventSocket.prototype.confirmWs = function() {
  confirmWs(this.request, this.socket);
};

EventSocket.prototype.close = function() {
  this.socket.end();
};

EventSocket.prototype._subscribeToTopic = function(topicString, limit) {
  var topic = new StreamTopic();
  try {
    topic.parse(topicString);
  } catch(err) {
    return err;
  }

  if (topic.pubsubIdentifier() === '') {
    return new Error('Topic must have server and specific topic. Specific topic missing.');
  }

  var compiled = null;
  if (topic.streamQuery) {
    try {
      var compiler = new JSCompiler();
      compiled = compiler.compile(topic.streamQuery);
    } catch(err) {
      return err;
    }
  }

  var subscription = {
    subscriptionId: ++this._subscriptionIndex,
    topic: topic,
    limit: limit,
    compiledQuery: compiled,
    count: 0
  };

  // Set internal ID
  subscription._id = uuid.v4();

  this._subscriptions.push(subscription);
  this.emit('subscribe', subscription);

  return true;
};

EventSocket.prototype._unsubscribe = function(subscriptionId, cb) {
  var self = this;
  var foundIdx = -1;
  self._subscriptions.some(function(subscription, idx) {
    if(subscription.subscriptionId === subscriptionId) {
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
    self._write(JSON.stringify(msg));
    return;
  }

  var subscription = self._subscriptions.splice(foundIdx, 1)[0];
  var msg = {
    type: 'unsubscribe-ack',
    timestamp: new Date().getTime(),
    subscriptionId: subscription.subscriptionId
  };

  self._write(JSON.stringify(msg));
  if (typeof cb === 'function') {
    cb(null, subscription);
  }
};


