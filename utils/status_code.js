module.exports = function(code) {
  if (code >= 100 && code < 200) {
    return '1xx';
  } if (code >= 200 && code < 300) {
    return '2xx';
  } else if (code >= 300 && code < 400) {
    return '3xx';
  } else if (code >= 400 && code < 500) {
    return '4xx';
  } else {
    return '5xx';
  }
};
