var path = require('path');
var o = {};
module.exports = o;

o.getFileName = function(p){
  return path.basename(p);
}
o.getParentPath = function(p){
  return path.dirname(p);
}
o.normalize = function(p){
  return path.normalize(p).replace(/\\/g, '/');
}
o.join = function(){
  var p = "";
  for(var i=0; i<arguments.length; i++){
    p = path.join(p, arguments[i]);
  }
  return this.normalize(p);
}
o.parse = function(p){
  return path.parse(p);
}
