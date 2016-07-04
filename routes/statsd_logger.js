var statusCode = require('../utils/status_code');

module.exports = function(client, request, response, handlerName, duration) {
  var tags = {
    tenant: request._tenantId
  };

  if (request._targetName) {
    tags.targetName = request._targetName;
  }

  tags.path = handlerName;
  tags.statusCode = response.statusCode;

  client.timing('http.req', duration, tags);
  client.increment('http.req', tags);
};
