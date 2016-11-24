var vscode = require('vscode');
var path = require('path');
var fs = require('fs');
var os = require('os');
var filesize = require('filesize');
var homeDir = os.homedir();
var pathUtil = require('./path-util');
var commonUtil = require('./common-util');
var fileUtil = require('./file-util');
var o = {};
module.exports = o;

/*
homeDir - C:\Users\humy2833
process.env.APPDATA - C:\Users\humy2833\AppData\Roaming
process.env.HOME - undefined
 */

o.getConfigPath = function(filename){
  var folder = process.env.APPDATA || (process.platform == 'darwin' ? process.env.HOME + '/Library/Application Support' : process.platform == 'linux' ? pathUtil.join(homeDir, '.config') : '/var/local');
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
o.open = o.openTextDocument = function(p, column, cb){
  if(typeof isNotShow === 'function') 
  {
    cb = column;
    column = 1;
  }
  if(!column) column = 1;
  vscode.workspace.openTextDocument(p).then(function (doc) {
    vscode.window.showTextDocument(doc, column).then(function(){
      if(cb) cb();
    });
  });
};
o.hide = function(){
  if(vscode.window.activeTextEditor)
  {
    try{
      vscode.window.activeTextEditor.hide();
    }catch(e){
      vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    }
  }
  else
  {
    vscode.commands.executeCommand("workbench.action.closeActiveEditor");
  }
};
o.msg = o.info = function(msg, btn, cb){
  var p = btn ? vscode.window.showInformationMessage(msg, btn) : vscode.window.showInformationMessage(msg);
  if(cb)
  {
    p.then(function(btn){
      cb(btn);
    });
  }
  return p;
};
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
};
o.error = function(msg, btn, cb){
  if(btn)  var p = vscode.window.showErrorMessage(msg, btn);
  else     var p = vscode.window.showErrorMessage(msg);
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
      // console.log(JSON.stringify(o));
      // if(!btn && option.value)
      // {
      //   if(typeof option.validateInput === 'function' && option.validateInput(option.value))
      //   {
      //     btn = option.value;
      //   }
      //   else btn = option.value;
      // }
      if(btn)cb(btn);
    });
  }
  return p;
};
o.status = function(msg, time){
  vscode.window.setStatusBarMessage(msg, time);
};
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
o.getActiveFilePathAll = function(){
  var docs = vscode.workspace.textDocuments;
  var arr = [];
  if(docs)
  {
    for(var i=0; i<docs.length; i++)
    {
      if(docs[i].uri && docs[i].uri.fsPath)
      {
        arr.push(pathUtil.normalize(docs[i].uri.fsPath));
      }
    }
  }
  return arr;
};
o.getActiveFilePath = function(item){
  var path = "";
  if(item && item.fsPath)
  {
    path = pathUtil.normalize(item.fsPath);
  }
  else
  {
    try{
      path = pathUtil.normalize(vscode.window.activeTextEditor.document.fileName);
    }catch(e){}
  }
  return path;
};
o.getActiveFilePathAndMsg = function(item, msg){
  var path = this.getActiveFilePath(item);  
  if(!path)
  {
    if(msg)this.msg(msg);
  }
  else
  {
    var isDir = false;
    try{isDir = fileUtil.isDirSync(path);}catch(e){};
    if(!isDir)
    {
      if(this.isUntitled()) 
      {
        this.msg("Please save first");
        path = "";
      }
      if(this.isDirty())  this.save();
    }
  }
  return path;
};
o.getActiveFileName = function(){
  var path = this.getActiveFilePath();
  if(path) return pathUtil.getFileName(path);
  else return null;
};
o.getWorkspacePath = function(){
  return vscode.workspace.rootPath ? pathUtil.normalize(vscode.workspace.rootPath) : undefined;
};
o.isUntitled = function(){
  return vscode.window.activeTextEditor ? vscode.window.activeTextEditor.document.isUntitled : undefined;
};
o.isDirty = function(){
  return vscode.window.activeTextEditor ? vscode.window.activeTextEditor.document.isDirty : undefined;
};
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
};
o.diff = function(left, right, title){
  if(fileUtil.existSync(left) && fileUtil.existSync(right))
  {
    if(!title)
    {
      title = "Local : " + pathUtil.getFileName(left) + " ↔ Remote : " + pathUtil.getFileName(right);
    }
    vscode.commands.executeCommand("vscode.diff", vscode.Uri.file(left), vscode.Uri.file(right), title);
  }
  else this.msg("Need the two files.");
};
o.getWorkspaceFileItemForPick = function(cb){
  var workspace = this.getWorkspacePath();
  if(!workspace) this.msg("The working directory does not exist.");
  this.getFileItemForPick(workspace, "d", function(items){
    cb(items);
  });
};
o.getFileItemForPick = function(path, filter, cb){
  if(arguments.length === 2)
  {
    cb = filter;
    filter = undefined;
  }
  fileUtil.ls(path, function(err, files){
    cb(o.makePickItemForFile(files, filter));
  });
};
o.makePickItemForFile = function(list, filter){
  var arr = [];
  for(var i=0; i<list.length; i++)
  {
    if(!filter || filter === list[i].type.toUpperCase())
      arr.push({label:list[i].name, description:"TYPE : " + (list[i].type.toUpperCase() == "D" ? "Directory" : "File") + ", DATE : "+list[i].date.toLocaleString() + ", SIZE : " + filesize(list[i].size), type:list[i].type.toUpperCase()});
  }
  arr.sort(function(a,b){
    if(a.type < b.type || a.type == b.type && a.label < b.label) return -1;
    if(a.type > b.type || a.type == b.type && a.label > b.label) return 1;
    return 0;
  });
  return arr;
};
o.addItemForFile = function(list, addItems, nowPath, rootPath){
  if(addItems && nowPath && (addItems instanceof Array || addItems === "."))
  {
    if(addItems === ".")
    {
      addItems = [{label:".", description:"Current directory : " + nowPath}];
    }
    else
    {
      for(var i in addItems)
      {
        if(typeof addItems[i] === "string") addItems[i] = {label:addItems[i]};
        if(addItems[i].label == ".")
        {
          addItems[i].description = "Current directory : " + nowPath;
        }
        else if(addItems[i].label == "*")
        {
          addItems[i].description = "Current all files : " + nowPath + "/**";
        }
      }
    }
    list = addItems.concat(list);
  }
  else if(arguments.length === 3 && typeof addItems === 'string')
  {
    rootPath = nowPath;
    nowPath = addItems;
  }
  if(nowPath && rootPath && nowPath.length > rootPath.length) list = [{label:"..", description:"Go to parent directory : " + pathUtil.getParentPath(nowPath)}].concat(list);
  return list;
};
o.openFolder = function(path, isNew){
  var uri = vscode.Uri.file(path);
  vscode.commands.executeCommand('vscode.openFolder', uri, isNew ? true : false);
};