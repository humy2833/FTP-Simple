var vscode = require('vscode');
var fs = require('fs');
var fse = require('fs-extra');
var filesize = require('filesize');
var pathUtil = require('./lib/path-util');
var fileUtil = require('./lib/file-util');
var commonUtil = require('./lib/common-util');
var vsUtil = require('./lib/vs-util');
var EasyFTP = require('easy-ftp');
var outputChannel = null;
var root = null;
var ftps = {};
const CONFIG_NAME = "ftp-simple.json";
const CONFIG_FTP_TEMP = "/ftp-simple/remote-temp";
const CONFIG_PATH = vsUtil.getConfigPath(CONFIG_NAME);
const REMOTE_TEMP_PATH = vsUtil.getConfigPath(CONFIG_FTP_TEMP);

function activate(context) {
  console.log("ftp-simple start");
  outputChannel = vsUtil.getOutputChannel("ftp-simple");

  vscode.workspace.onDidSaveTextDocument(function(event){
    var remoteTempPath = pathUtil.normalize(event.fileName);
    var ftpConfig = getFTPConfigFromRemoteTempPath(remoteTempPath);
    if(ftpConfig.config && ftpConfig.path)
    {
      var ftp = createFTP(ftpConfig.config, function(){
        ftp.upload(remoteTempPath, ftpConfig.path);
      });
    }
  });
  vscode.workspace.onDidCloseTextDocument(function(event){
    var remoteTempPath = pathUtil.normalize(event.fileName);
    var ftpConfig = getFTPConfigFromRemoteTempPath(remoteTempPath);
    if(ftpConfig.config && ftpConfig.path)
    {
      fs.unlink(pathUtil.normalize(event.fileName));
    }
  });
  vscode.window.onDidChangeActiveTextEditor(function(event){
    var remoteTempPath = pathUtil.normalize(event.document.fileName);
    var ftpConfig = getFTPConfigFromRemoteTempPath(remoteTempPath);
    if(ftpConfig.config && ftpConfig.path)
    {
      vsUtil.status("If save, Auto save to remote server.");
    }
    else
    {
      vsUtil.status("");
    }
  });

  var ftpConfig = vscode.commands.registerCommand('ftp.remote.config', function () {
      //확장 설정 가져오기(hello.abcd 일때);
      //console.log(JSON.stringify(vscode.workspace.getConfiguration('hello')));
      if(initConfig()){
        vsUtil.openTextDocument(CONFIG_PATH);
      }
  });

  var ftpDelete = vscode.commands.registerCommand('ftp.remote.delete', function () {
    getSelectedFTPConfig(function(ftpConfig)
    {
      var ftp = createFTP(ftpConfig);
      getSelectedFTPFile(ftp, ftpConfig, ftpConfig.path, "Select the file or path want to delete", [{label:".", description:ftpConfig.path}], function selectItem(item, parentPath, filePath){
        if(!item)
        {
          return;
        }
        var deletePath = filePath ? filePath : parentPath;
        vsUtil.warning("Are you sure you want to delete '"+deletePath+"'?", "Back", "OK")
        .then(function(btn){
          if(btn == "OK") 
          {
            ftp.rm(deletePath, function(err){
              if(err) vsUtil.error(err.toString());
              else output("Deleted : " + deletePath);
            });
          }
          else if(btn == "Back") getSelectedFTPFile(ftp, ftpConfig, parentPath, "Select the file or path want to delete", [{label:".", description:parentPath}], selectItem);
        });
      });
    }); 
  });

  var ftpMkdir = vscode.commands.registerCommand('ftp.remote.mkdir', function () {
    getSelectedFTPConfig(function(ftpConfig)
    {
      var ftp = createFTP(ftpConfig);
      getSelectedFTPFile(ftp, ftpConfig, ftpConfig.path, "Select the path want to create directory", [{label:".", description:ftpConfig.path}], "D", function selectItem(item, parentPath, filePath){
        if(!item)
        {
          return;
        }
        create(ftp, parentPath);
      });
      function create(ftp, path, value){
        var isInput = false;
        vsUtil.input({
            value : value ? value : ""
          , placeHolder : "Enter the name of the directory to be created"
          , prompt : "Now path : " + path
          , validateInput : function(value){
              return isInput = /[\\|*?<>:"]/.test(value) ? true : null;
          }
        }).then(function(name){
          if(name) 
          {
            var parent = path;
            var realName = name;
            if(name.indexOf("/") > 0)
            {
              parent = pathUtil.join(path, pathUtil.getParentPath(name));
              realName = pathUtil.getFileName(name);
            }
            exist(ftp, parent, realName, function(result){
              if(result) 
              {
                vsUtil.error("Already exist directory '"+name+"'", "Rename")
                .then(function(btn){
                  if(btn) create(ftp, path, name);
                });
              }
              else 
              {
                var p = pathUtil.join(path, name);
                ftp.mkdir(p, function(err){
                  if(!err) output("Create directory : " + p);
                });
              }
            });
          }
          else 
          {
            if(isInput) 
            {
              vsUtil.error("Filename to include inappropriate words.");
              create(ftp, path);
            }
          }
        });
      }
    }); 
  });

  var ftpOpen = vscode.commands.registerCommand('ftp.remote.open', function () {
    getSelectedFTPConfig(function(ftpConfig)
    {
      var ftp = createFTP(ftpConfig);    
      getSelectedFTPFile(ftp, ftpConfig, ftpConfig.path, "Select the file want to open", function(item, parentPath, filePath){          
        if(item){
          downloadOpen(ftp, ftpConfig, filePath);
        }
      });
    });
  });
  
  var ftpSave = vscode.commands.registerCommand('ftp.remote.save', function (item) {
    var localFilePath, isForceUpload = false;
    if(item && item.fsPath)
    {
      isForceUpload = true;
      localFilePath = pathUtil.normalize(item.fsPath);
    }
    else localFilePath = vsUtil.getActiveFilePath();

    var isDir = fileUtil.isDirSync(localFilePath);
    if(!localFilePath)
    {
      vsUtil.msg("Please select a file to upload");
      return;
    }
    if(!isDir && vsUtil.isUntitled())
    {
      vsUtil.msg("Please save first");
      return;
    }
    if(vsUtil.isDirty())  vsUtil.save();

    getSelectedFTPConfig(function(ftpConfig)
    {
      var ftp = createFTP(ftpConfig);
      getSelectedFTPFile(ftp, ftpConfig, ftpConfig.path, "Select the path" + (isDir ? "" : " or file") + " want to save", [{label:".", description:ftpConfig.path}], (isDir ? "D" : null), function selectItem(item, path, filePath){
        if(item)
        {
          if(filePath)
          {
            confirmExist(ftp, localFilePath, filePath);
          }
          else
          {
            var fileName = pathUtil.getFileName(localFilePath);
            var isInput = false;
            vsUtil.input({value : fileName
              , placeHolder : "Write the " + (isDir ? "directory" : "file") + " name"
              , prompt : "Write the " + (isDir ? "directory" : "file") + " name"
              , validateInput : function(value){
                  return isInput = /[\\\/|*?<>:"]/.test(value) ? true : null;
              }
            }).then(function(name){
              if(name) existProc(name);
              else 
              {
                if(isInput) vsUtil.error("Filename to include inappropriate words.");
              }
            });

            function existProc(fileName){
              exist(ftp, path, fileName, function(result){
                if(result) confirmExist(ftp, localFilePath, pathUtil.join(path, fileName));
                else
                {
                  upload(ftp, ftpConfig, localFilePath, pathUtil.join(path, fileName));
                }
              });
              }
          }
        }

        function upload(ftp, ftpConfig, localPath, remotePath){
          if(isDir) localPath = localPath + "/**";
          ftp.upload(localPath, remotePath, function(err){
            if(!err && !isForceUpload)
            {
              vsUtil.hide();
              downloadOpen(ftp, ftpConfig, remotePath);
            }
            if(!err && isDir) output(ftpConfig.name + " - Directory uploaded : " + remotePath);
          });
        }
        function confirmExist(ftp, localPath, remotePath, cb){
          vsUtil.warning("Already exist " + (isDir ? "directory" : "file") + " '"+remotePath+"'. Overwrite?", "Back", "OK").then(function(btn){
            if(btn == "OK") upload(ftp, ftpConfig, localPath, remotePath);
            else if(btn == "Back") getSelectedFTPFile(ftp, ftpConfig, path, "Select the path" + (isDir ? "" : " or file") + " want to save", [{label:".", description:path}], selectItem);
          });
        }
      });
    });
  });

  context.subscriptions.push(ftpConfig);
  context.subscriptions.push(ftpDelete);
  context.subscriptions.push(ftpMkdir);
  context.subscriptions.push(ftpOpen);
  context.subscriptions.push(ftpSave);
}
exports.activate = activate;

// this method is called when your extension is deactivated
function deactivate() {
  closeFTPAll();
  fse.remove(pathUtil.getParentPath(REMOTE_TEMP_PATH), function(){
  });
}
exports.deactivate = deactivate;

function createFTP(ftpConfig, cb){
  var ftp = getFTP(ftpConfig.host, function(result){
    if(result)
    {
      if(cb) cb();
    }
    else
    {
      var TRY = 5;
      var count = 0;
      //var ftp = new EasyFTP();
      output(ftpConfig.name + " - " + "FTP Connecting...");
      ftp.connect(ftpConfig);
      ftp.on("open", function(){        
        count = TRY;
        output(ftpConfig.name + " - " + "FTP open!!");
        addFTP(ftpConfig.host, ftp);
        if(cb) cb();
      });
      ftp.on("close", function(){
        output(ftpConfig.name + " - " + "FTP close!!");
        deleteFTP(ftpConfig.host);
      });
      ftp.on("error", function(err){
        output(ftpConfig.name + " - " + err);
        if(String(err).indexOf("Timed out while waiting for handshake") > -1) TRY = 0;
        if(count < TRY)
        {
          count++;
          setTimeout(function(){
            output(ftpConfig.name + " - " + "FTP Connecting try...");
            ftp.connect(ftpConfig);
          }, 200);
        }
      });
      ftp.on("upload", function(path){
        output(ftpConfig.name + " - " + "Uploaded : " + path);
      });
      ftp.on("download", function(path){
        output(ftpConfig.name + " - " + "Downloaded : " + path);
      });
    }
  });
  return ftp;

  function addFTP(host, ftp){
    var result = true;
    var key = commonUtil.md5(host);
    ftps[key] = ftp;
  }
  function deleteFTP(host){
    var key = commonUtil.md5(host);
    if(ftps[key])
    {
      delete ftps[key];
    }
  }
  function getFTP(host, cb){
    var key = commonUtil.md5(host);
    if(ftps[key])
    {
      try{
        ftps[key].pwd(function(err, path){
          if(cb) process.nextTick(cb, err ? undefined : ftps[key]);
        });
      }catch(e){
        if(cb)cb();
      }
    }
    else 
    {
      ftps[key] = new EasyFTP();
      process.nextTick(cb);
    }
    return ftps[key];
  }
}
function closeFTPAll(){
  for(var i in ftps)
  {
    try{ftps[i].close();}catch(e){}
    delete ftps[i];
  }
}
function initConfig(){
  var result = true;
  try{
    var json = vsUtil.getConfig(CONFIG_NAME, JSON.parse);
    if(json === undefined){
      fs.writeFileSync(CONFIG_PATH, JSON.stringify([{name:"localhost", host:"", port:21, type:"ftp", username:"", password:"", path:"/"}], null, "\t"));
    }
  }catch(e){
    //console.log(e);
    vsUtil.msg("Check config file.");
    result = false;
  }
  return result;
}
function getConfig(){
  var json = {};
  if(initConfig())
  {
    json = vsUtil.getConfig(CONFIG_NAME, JSON.parse);
  }
  return json;
}
function getFTPNames(config){
  var names = [];
  for(var i in config)
  {
    names.push(config[i].name || config[i].host || "undefined");
  }
  return names;
}
function getFTPConnectInfo(config, name, key){
  key = key ? key : "name";
  for(var i in config)
  {
    if(config[i][key] == name || commonUtil.md5(config[i][key]) == name)
    {
      return config[i];
    }
  }
  return null;
}
function output(str){
  vsUtil.output(outputChannel, str);
}
function getFTPConfig(ftpsConfig, name, key){
  var ftpConfig = getFTPConnectInfo(ftpsConfig, name, key);
  if(ftpConfig)
  {
    if(!ftpConfig.path) ftpConfig.path = "/";
    else ftpConfig.path = pathUtil.normalize(ftpConfig.path);
  }  
  return ftpConfig;
}
function getSelectedFTPConfig(cb){
  var ftpsConfig = getConfig();
  var ftps = getFTPNames(ftpsConfig);
  if(ftps.length == 0)
  {
    vsUtil.msg('Check config file.');
    return;
  }
  vsUtil.pick(ftps, "Select FTP server", function(name) {
    if(cb)cb(getFTPConfig(ftpsConfig, name));
  });
}
function getSelectedFTPFile(ftp, ftpConfig, path, placeHolder, addItems, filter, cb){
  if(typeof addItems === 'function')
  {
    cb = addItems;
    addItems = undefined;
  }
  if(typeof filter === 'function')
  {
    cb = filter;
    filter = undefined;
  }
  path = pathUtil.normalize(path);
  ftp.ls(path, function(err, list){
    if(!err) output("cd " + path);
    else 
    {
      vsUtil.error("Not exist '"+path+"'");
      return;
    }
    var arr = [];
    for(var i in list)
    {
      if(!filter || filter === list[i].type.toUpperCase())
        arr.push({label:list[i].name, description:"TYPE : " + (list[i].type.toUpperCase() == "D" ? "Directory" : "File") + ", DATE : "+list[i].date.toLocaleString() + ", SIZE : " + filesize(list[i].size), type:list[i].type.toUpperCase()});
    }
    arr.sort(function(a,b){
      if(a.type < b.type || a.type == b.type && a.label < b.label) return -1;
      if(a.type > b.type || a.type == b.type && a.label > b.label) return 1;
      return 0;
    });
    if(addItems)
    {
      for(var i in addItems)
      {
        if(addItems[i].label && addItems[i].description && addItems[i].label == ".")
        {
          addItems[i].description = "Current directory : " + path;
          break;
        }
      }
      arr = addItems.concat(arr);
    }
    if(path.length > ftpConfig.path.length) arr = [{label:"..", description:"Go to parent directory : " + pathUtil.getParentPath(path)}].concat(arr);
    vsUtil.pick(arr, placeHolder + ".  Now path '" + path + "'").then(function(item){
      if(!item){
        if(cb)cb();
      }else if(item.label == ".."){
        getSelectedFTPFile(ftp, ftpConfig, pathUtil.getParentPath(path), placeHolder, addItems, filter, cb);
      }else if(item.type === "D"){
        getSelectedFTPFile(ftp, ftpConfig, pathUtil.join(path, item.label), placeHolder, addItems, filter, cb);
      }else{
        if(cb)cb(item, path, item.type ? pathUtil.join(path, item.label) : null);
      }
    });
  });
}
function getFTPConfigFromRemoteTempPath(remoteTempPath){
  var ftpConfig, remotePath;
  if(remoteTempPath.indexOf(REMOTE_TEMP_PATH) === 0)
  {
    var host = remoteTempPath.substring(REMOTE_TEMP_PATH.length + 1);
    remotePath = host.substring(host.indexOf("/"));
    host = host.substring(0, host.indexOf("/"));
    ftpConfig = getFTPConfig(getConfig(), host, "host");
  }
  return {config : ftpConfig, path : remotePath};
}
function downloadOpen(ftp, ftpConfig, remotePath, cb){
  var localPath = pathUtil.join(REMOTE_TEMP_PATH, commonUtil.md5(ftpConfig.host), remotePath);
  ftp.download(remotePath, localPath, function(path){
    if(cb)cb();
    fs.stat(localPath, function(err){
      if(!err)
      {
        vsUtil.open(localPath);
      }
    });
  });
}
function exist(ftp, path, name, cb){
  ftp.ls(path, function(err, list){
    var same = false;
    if(err) list = [];
    for(var i in list)
    {
      if(list[i].name == name)
      {
        same = true;
        break;
      }
    }
    if(cb)cb(same);
  });
}