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
  destroy();
  
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

  var ftpConfig = vscode.commands.registerCommand('ftp.config', function () {
      //확장 설정 가져오기(hello.abcd 일때);
      //console.log(JSON.stringify(vscode.workspace.getConfiguration('hello')));
      if(initConfig()){
        vsUtil.openTextDocument(CONFIG_PATH);
      }
  });

  var ftpDownload = vscode.commands.registerCommand('ftp.download', function () {
    var workspacePath = vsUtil.getWorkspacePath();
    if(!workspacePath)
    {
      vsUtil.msg("Please, open the workspace directory first.");
      return;
    }
    getSelectedFTPConfig(function(ftpConfig)
    {
      var ftp = createFTP(ftpConfig);
      getSelectedFTPFile(ftp, ftpConfig, ftpConfig.path, "Select the file or directory want to download", ".", function(serverItem, serverParentPath, serverFilePath){
        getSelectedLocalPath(workspacePath, workspacePath, "Select the path want to download", ".", "D", selectItem); 
        function selectItem(item, parentPath, filePath){
          var isDir = serverFilePath ? false : true;
          var localPath = isDir ? pathUtil.join(parentPath, pathUtil.getFileName(serverParentPath)) : pathUtil.join(parentPath, serverItem.label);
          var remotePath = isDir ? serverParentPath + "/**" : serverFilePath;
          if(fileUtil.existSync(localPath))
          {
            confirmExist(ftp, isDir, parentPath, remotePath, localPath);
          }
          else
          {
            download(ftp, remotePath, localPath);
          }
        }
        function confirmExist(ftp, isDir, path, remotePath, localPath){
          vsUtil.warning("Already exist " + (isDir ? "directory" : "file") + " '"+localPath+"'. Overwrite?", "Back", "OK").then(function(btn){
            if(btn == "OK") download(ftp, remotePath, localPath);
            else if(btn == "Back") getSelectedLocalPath(path, workspacePath, "Select the path want to download", ".", "D", selectItem);
          });
        }
        function download(ftp, remotePath, localPath, cb){
          ftp.download(remotePath, localPath, function(err){
            if(!err && !serverFilePath) output(ftpConfig.name + " - Directory downloaded : " + localPath);
            if(cb)cb();
          })
        }       
      });
    });
  });

  var ftpDiff = vscode.commands.registerCommand('ftp.diff', function (item) {
      var localFilePath = vsUtil.getActiveFilePath(item, "Please select a file to compare");
      if(!localFilePath) return;
      if(fileUtil.isDirSync(localFilePath))
      {
        vsUtil.msg("Select a file. The directory is impossible.");
        return;
      }
      getSelectedFTPConfig(function(ftpConfig)
      {
        var ftp = createFTP(ftpConfig);
        getSelectedFTPFile(ftp, ftpConfig, ftpConfig.path, "Select the file want to compare", function selectItem(item, parentPath, filePath){
          download(ftp, ftpConfig, filePath, function(err, path){
            if(!err)
            {
              vsUtil.diff(localFilePath, path);
            }
          });
        });
      });
  });

  var ftpDelete = vscode.commands.registerCommand('ftp.delete', function () {
    getSelectedFTPConfig(function(ftpConfig)
    {
      var ftp = createFTP(ftpConfig);
      getSelectedFTPFile(ftp, ftpConfig, ftpConfig.path, "Select the file or path want to delete", [{label:".", description:ftpConfig.path}], function selectItem(item, parentPath, filePath){
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

  var ftpMkdir = vscode.commands.registerCommand('ftp.mkdir', function () {
    getSelectedFTPConfig(function(ftpConfig)
    {
      var ftp = createFTP(ftpConfig);
      getSelectedFTPFile(ftp, ftpConfig, ftpConfig.path, "Select the path want to create directory", [{label:".", description:ftpConfig.path}], "D", function selectItem(item, parentPath, filePath){
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

  var ftpOpen = vscode.commands.registerCommand('ftp.open', function () {
    getSelectedFTPConfig(function(ftpConfig)
    {
      var ftp = createFTP(ftpConfig);    
      getSelectedFTPFile(ftp, ftpConfig, ftpConfig.path, "Select the file want to open", function(item, parentPath, filePath){
        downloadOpen(ftp, ftpConfig, filePath);
      });
    });
  });
  
  var ftpSave = vscode.commands.registerCommand('ftp.save', function (item) {
    var localFilePath = vsUtil.getActiveFilePath(item, "Please select a file to upload");
    if(!localFilePath) return;
    var isForceUpload = item && item.fsPath ? true : false;
    var isDir = fileUtil.isDirSync(localFilePath);
    getSelectedFTPConfig(function(ftpConfig)
    {
      var ftp = createFTP(ftpConfig);
      getSelectedFTPFile(ftp, ftpConfig, ftpConfig.path, "Select the path" + (isDir ? "" : " or file") + " want to save", [{label:".", description:ftpConfig.path}], (isDir ? "D" : null), selectItem);
      
      function selectItem(item, path, filePath){
        if(filePath)
        {
          confirmExist(ftp, path, localFilePath, filePath);
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
              if(result) confirmExist(ftp, path, localFilePath, pathUtil.join(path, fileName));
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
      function confirmExist(ftp, path, localPath, remotePath){
        vsUtil.warning("Already exist " + (isDir ? "directory" : "file") + " '"+remotePath+"'. Overwrite?", "Back", "OK").then(function(btn){
          if(btn == "OK") upload(ftp, ftpConfig, localPath, remotePath);
          else if(btn == "Back") getSelectedFTPFile(ftp, ftpConfig, path, "Select the path" + (isDir ? "" : " or file") + " want to save", [{label:".", description:path}], selectItem);
        });
      }
    });
  });

  context.subscriptions.push(ftpConfig);
  context.subscriptions.push(ftpDelete);
  context.subscriptions.push(ftpMkdir);
  context.subscriptions.push(ftpOpen);
  context.subscriptions.push(ftpSave);
  context.subscriptions.push(ftpDiff);
  context.subscriptions.push(ftpDownload);
}
exports.activate = activate;

// this method is called when your extension is deactivated
function deactivate() {
  closeFTPAll();
  destroy();
}
exports.deactivate = deactivate;

function destroy(){
  fse.remove(pathUtil.getParentPath(REMOTE_TEMP_PATH), function(){});
}
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
function getSelectedLocalPath(path, rootPath, placeHolder, addItems, filter, cb){
  vsUtil.getFileItemForPick(path, filter, function(items){
    arr = vsUtil.addItemForFile(items, addItems, path, rootPath);
    vsUtil.pick(arr, placeHolder + ".  Now path '" + path + "'").then(function(item){
      if(item)
      {
        if(item.label == ".."){
          getSelectedLocalPath(pathUtil.getParentPath(path), rootPath, placeHolder, addItems, filter, cb);
        }else if(item.type === "D"){
          getSelectedLocalPath(pathUtil.join(path, item.label), rootPath, placeHolder, addItems, filter, cb);
        }else{
          if(cb)cb(item, path, item.type ? pathUtil.join(path, item.label) : null);
        }
      }
    });
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
    var arr = vsUtil.makePickItemForFile(list, filter);
    arr = vsUtil.addItemForFile(arr, addItems, path, ftpConfig.path);
    vsUtil.pick(arr, placeHolder + ".  Now path '" + path + "'").then(function(item){
      if(item)
      {
        if(item.label == ".."){
          getSelectedFTPFile(ftp, ftpConfig, pathUtil.getParentPath(path), placeHolder, addItems, filter, cb);
        }else if(item.type === "D"){
          getSelectedFTPFile(ftp, ftpConfig, pathUtil.join(path, item.label), placeHolder, addItems, filter, cb);
        }else{
          if(cb)cb(item, path, item.type ? pathUtil.join(path, item.label) : null);
        }
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
function download(ftp, ftpConfig, remotePath, cb){
  var localPath = pathUtil.join(REMOTE_TEMP_PATH, commonUtil.md5(ftpConfig.host), remotePath);
  ftp.download(remotePath, localPath, function(err){
    if(cb)cb(err, localPath);
  });
}
function downloadOpen(ftp, ftpConfig, remotePath, cb){
  download(ftp, ftpConfig, remotePath, function(err, localPath){
    if(cb)cb();
    if(!err)
    {
      fs.stat(localPath, function(err){
        if(!err) vsUtil.open(localPath);
      });
    }
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