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

var statusCode = require('./status_code');
var parseUri = require('./parse_uri')
var sirenResponse = require('./siren_response');

var Handler = module.exports = function(proxy) {
  this.proxy = proxy;
};

Handler.prototype.request = function(request, response, parsed) {
  var self = this;
  var body = {
    class: ['router-state'],
    properties: {
    },
    entities: [],
    links: [
      { rel: ['self'], href: parseUri(request) }
    ]
  };

  

  Object.keys(this.proxy._targetMonitor.state).forEach(function(targetUrl) {
    var entity = {
      class: ['target-state'],
      properties: {},
      links: [ 
        { rel: ['self'], href: parseUri(request) }
      ]
    };

    entity.properties.url = targetUrl;
    Object.keys(self.proxy._targetMonitor.state[targetUrl]).forEach(function(k) {
      entity.properties[k] = self.proxy._targetMonitor.state[targetUrl][k];
    });
    
    body.entities.push(entity);
  });

  return sirenResponse(response, 200, body);
};
