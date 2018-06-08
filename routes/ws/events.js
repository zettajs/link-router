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
var EventBroker = require('./event_broker');
var EventSocket = require('./event_socket');

var Handler = module.exports = function(proxy) {
  this.proxy = proxy;
  this._cache = {};
  this._queryCache = {};
  this._eventBroker = new EventBroker(proxy);
  this._numberConnected = {}; // { <wsPath>: Number }


  // Send gauge for the number of clients connected to each socket type
  // every 5 sec
  var self = this;
  setInterval(function() {
    Object.keys(self._numberConnected).forEach(function(wsPath) {
      self.proxy._statsClient.gauge('ws.clients', self._numberConnected[wsPath], { path: wsPath });
    });
  }, 5000);
};

Handler.prototype.handler = function(request, socket, wsReceiver) {
  var self = this;
  var streamEnabled = false;
  var subscriptions = []; // list of subscriptions to subscribed to initially

  var wsPath = 'na';
  var targetName = null;
  
  if (/^\/events$/.test(request.url)) {
    // /events for multiplexed
    streamEnabled = true;
    wsPath = 'multiplexed';
  } else if (/^\/peer-management$/.test(request.url)) {
    // /peer-management
    subscriptions.push('_peer/*');
    wsPath = 'peer-management';
  } else if (/^\/events\?/.test(request.url)) {
    // /events?topic=
    var parsed = url.parse(request.url, true);
    if (parsed.query.topic.indexOf('query/') === 0 || parsed.query.topic.indexOf('query:') === 0) {
      // append * for server to device queries
      subscriptions.push('*/' + parsed.query.topic);
      wsPath = 'device-query';
    } else {
      subscriptions.push(parsed.query.topic);
      wsPath = 'events';
    }
  } else if (/^\/servers\/(.+)$/.test(request.url)) {
    // /servers/<targetName>/events?topic=...
    var parsed = url.parse(request.url, true);
    targetName = decodeURIComponent(/^\/servers\/(.+)$/.exec(parsed.pathname)[1].split('/')[0]);
    wsPath = 'single-topic';
    if (!parsed.query.topic) {
      // return 400
      var responseLine = 'HTTP/1.1 400  ' + err.message + '\r\n\r\n\r\n';
      socket.end(responseLine);
      var tags = { path: wsPath, statusCode: 400 };
      if (targetName) {
        tags.targetName = targetName;
      }
      this.proxy._statsClient.increment('ws.req', tags);
      return;
    }
    subscriptions.push(targetName + '/' + parsed.query.topic);
  }

  var client = new EventSocket(request, socket, wsReceiver, { streamEnabled: streamEnabled });
  this._eventBroker.client(client);

  var err = null;
  subscriptions.every(function(topic) {
    var ret = client._subscribeToTopic(topic);
    if (ret !== true) {
      err = ret;
      return false;
    } else {
      return true;
    }
  });

  if (err) {
    var responseLine = 'HTTP/1.1 400  ' + err.message + '\r\n\r\n\r\n';
    socket.end(responseLine);

    var tags = { path: wsPath, statusCode: 400 };
    if (targetName) {
      tags.targetName = targetName;
    }
    this.proxy._statsClient.increment('ws.req', tags);
    return;
  }

  client.confirmWs();

  // Keep track of the number of ws clients connected per socket type
  if (!this._numberConnected.hasOwnProperty(wsPath)) {
    this._numberConnected[wsPath] = 0;
  }
  this._numberConnected[wsPath]++;
  client.once('close', function() {
    self._numberConnected[wsPath]--;
  });
  

  // Send connection metric
  var tags = { path: wsPath, statusCode: 101 };
  if (targetName) {
    tags.targetName = targetName;
  }
  this.proxy._statsClient.increment('ws.req', tags);
};
