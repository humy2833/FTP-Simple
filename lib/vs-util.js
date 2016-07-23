var vscode = require('vscode');
var path = require('path');
var fs = require('fs');
var pathUtil = require('./path-util');
var commonUtil = require('./common-util');
var o = {};
module.exports = o;

o.getConfigPath = function(filename){
  var folder = process.env.APPDATA || (process.platform == 'darwin' ? process.env.HOME + '/Library/Application Support' : '/var/local');
  if(/^[A-Z]\:[/\\]/.test(folder)) folder = folder.substring(0, 1).toLowerCase() + folder.substring(1);
  return pathUtil.join(folder, "/Code/User/", filename ? filename : "");
}
o.existConfig = function(filename){
  var result = true;
  if(fs.accessSync){
    try{fs.accessSync(this.getConfigPath(filename));}catch(e){result=false;}
  }else{
    result = fs.existsSync(this.getConfigPath(filename));
  }
  return result;
}
o.getConfig = function(filename, pipe){
  var val;
  if(this.existConfig(filename))
  {
    var path = this.getConfigPath(filename);
    val = fs.readFileSync(path).toString();
    if(pipe) {
      try{
        val = pipe(val);
      }catch(e){throw e;}
    }
  }
  return val;
}
o.getOutputChannel = function(name){
  return o.getOutputChannel.channels[name] ? o.getOutputChannel.channels[name] : o.getOutputChannel.channels[name] = vscode.window.createOutputChannel(name);
}
o.getOutputChannel.channels = {};

o.output = function(outputChannel, str){
  (typeof outputChannel === 'string' ? this.getOutputChannel(outputChannel) : outputChannel).appendLine("[" + commonUtil.getNow() + "] " + str);
}
o.open = o.openTextDocument = function(p){
  vscode.workspace.openTextDocument(p).then(function (doc) {
    vscode.window.showTextDocument(doc);
  });
};
o.hide = function(){
  if(vscode.window.activeTextEditor) vscode.window.activeTextEditor.hide();
  else if(workbench && workbench.action) workbench.action.closeActiveEditor();
}
o.msg = o.info = function(msg, btn, cb){
  var p = vscode.window.showInformationMessage(msg, btn);
  if(cb)
  {
    p.then(function(btn){
      cb(btn);
    });
  }
  return p;
}
o.warning = o.confirm = function(msg, btn1, btn2, cb){
  if(typeof btn2 === 'function')
  {
    cb = btn2;
    btn2 = undefined;
  }
  var p = vscode.window.showWarningMessage(msg, btn1, btn2);
  if(cb)
  {
    p.then(function(btn){
      cb(btn);
    });
  }
  return p;
}
o.error = function(msg, btn, cb){
  var p = vscode.window.showErrorMessage(msg, btn);
  if(cb)
  {
    p.then(function(btn){
      cb(btn);
    });
  }
  return p;
}
o.input = function(option, cb){
  var p = vscode.window.showInputBox(option);
  if(cb)
  {
    p.then(function(btn){
      cb(btn);
    });
  }
  return p;
}
o.status = function(msg, time){
  vscode.window.setStatusBarMessage(msg, time);
}
o.pick = o.showQuickPick = function(data, option, cb){
  if(arguments.length === 2 && typeof option === 'function'){
    cb = option;
    option = undefined;
  } else if(typeof option === 'string'){
    option = {placeHolder:option};
  }
  var p = vscode.window.showQuickPick(data, option);
  if(cb) p.then(function(val){if(val)cb(val);});
  return p;
}
o.getActiveFilePath = function(){
  var path = "";
  try{
    path = pathUtil.normalize(vscode.window.activeTextEditor.document.fileName);
  }catch(e){}
  return path;
}
o.getActiveFileName = function(){
  var path = this.getActiveFilePath();
  if(path) return pathUtil.getActiveFileName(path);
  else return null;
}
o.getWorkspacePath = function(){
  return vscode.workspace.rootPath ? pathUtil.normalize(vscode.workspace.rootPath) : undefined;
}
o.isUntitled = function(){
  return vscode.window.activeTextEditor ? vscode.window.activeTextEditor.document.isUntitled : undefined;
}
o.isDirty = function(){
  return vscode.window.activeTextEditor ? vscode.window.activeTextEditor.document.isDirty : undefined;
}
o.save = function(cb){
  var dirty = this.isDirty();
  if(dirty)
  {
    vscode.window.activeTextEditor.document.save().then(function(result){
      if(cb)cb(result);
    });
  }
  else if(dirty === false) cb(true);
  else if(cb) cb();
}
