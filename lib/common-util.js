'use strict';
const crypto = require('crypto');
var o = {};
module.exports = o;

o.lpad = function(n){
  return n < 10 ? "0" + n : n;
}
o.getNow = function(){
  var d = new Date();
  return d.getFullYear() + "-" + this.lpad(d.getMonth()+1) + "-" + this.lpad(d.getDate()) + " " + this.lpad(d.getHours()) + ":" + this.lpad(d.getMinutes()) + ":" + this.lpad(d.getSeconds()); 
}
o.md5 = function(str){
  const hash = crypto.createHash('md5');
  hash.update(str);
  return hash.digest('hex');
}