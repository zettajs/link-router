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

    Object.keys(self.proxy._targetMonitor.state[targetUrl]).forEach(function(k) {
      entity.properties[k] = self.proxy._targetMonitor.state[targetUrl][k];
    });
    
    body.entities.push(entity);
  });

  return sirenResponse(response, 200, body);
};
