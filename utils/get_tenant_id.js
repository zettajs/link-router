module.exports = function(request) {
  return request.headers['x-apigee-iot-tenant-id'] || 'default';
};
