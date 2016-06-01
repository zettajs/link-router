var statusCode = require('../utils/status_code');

module.exports = function(client, request, response, handlerName, duration) {
  var tags = {
    tenant: request._tenantId
  };

  if (request._targetName) {
    tags.targetName = request._targetName;
  }
  
  client.timing('http.req.' + handlerName, duration, tags);
  client.increment('http.req.' + handlerName + '.status.' + statusCode(response.statusCode), tags);
};
