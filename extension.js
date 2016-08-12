var vscode = require('vscode');
var fs = require('fs');
var fse = require('fs-extra');
var loop = require('easy-loop');
var filesize = require('filesize');
var pathUtil = require('./lib/path-util');
var fileUtil = require('./lib/file-util');
var commonUtil = require('./lib/common-util');
var vsUtil = require('./lib/vs-util');
var EasyFTP = require('easy-ftp');
var outputChannel = null;
var root = null;
var ftps = {};
var remoteRefreshFlag = false;
const CONFIG_NAME = "ftp-simple.json";
const CONFIG_FTP_TEMP = "/ftp-simple/remote-temp";
const CONFIG_FTP_WORKSPACE_TEMP = "/ftp-simple/remote-workspace-temp";
const CONFIG_PATH = vsUtil.getConfigPath(CONFIG_NAME);
const REMOTE_TEMP_PATH = vsUtil.getConfigPath(CONFIG_FTP_TEMP);
const REMOTE_WORKSPACE_TEMP_PATH = vsUtil.getConfigPath(CONFIG_FTP_WORKSPACE_TEMP);

function activate(context) {
  var subscriptions = [];
  console.log("ftp-simple start");
  outputChannel = vsUtil.getOutputChannel("ftp-simple");
  destroy(true);
 
  setRefreshRemoteTimer(true);
  

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
    if(isRemoteTempWorkspaceFile(remoteTempPath))
    {
      if(fileUtil.existSync(remoteTempPath))
      {
        fileUtil.writeFile(remoteTempPath, "", function(){});
      }
      else
      {
        var ftp = createFTP(ftpConfig.config, function(){
          ftp.rm(ftpConfig.path, function(err){
            if(!err) output("Deleted : " + ftpConfig.path);
          });
        });
      }
    }
    else if(ftpConfig.config && ftpConfig.path)
    {
      fs.unlink(pathUtil.normalize(event.fileName));
    }
  });
  vscode.window.onDidChangeActiveTextEditor(function(event){
    var remoteTempPath = pathUtil.normalize(event.document.fileName);
    // console.log("doc change : ", remoteTempPath);
    var ftpConfig = getFTPConfigFromRemoteTempPath(remoteTempPath);  
    var stat = fileUtil.statSync(remoteTempPath);
    if(isRemoteTempWorkspaceFile(remoteTempPath) && stat.size === 0)
    {
      var ftp = createFTP(ftpConfig.config, function(){
        if(new Date().getTime() - stat.date.getTime() >= 100)
        {
          ftp.download(ftpConfig.path, remoteTempPath, function(){            
            downloadRemoteWorkspace(ftp, ftpConfig.config.host, pathUtil.getParentPath(ftpConfig.path), function(localPath){
            }, true, true);
          });
        }
        else  //new file
        {
          ftp.upload(remoteTempPath, ftpConfig.path);
        }
      });
    }
    if(ftpConfig.config && ftpConfig.path)
    {
      vsUtil.status("If save, Auto save to remote server.");
    }
    else
    {
      vsUtil.status("");
    }
  });

  subscriptions.push(vscode.commands.registerCommand('ftp.config', function () {
    //확장 설정 가져오기(hello.abcd 일때);
    //console.log(JSON.stringify(vscode.workspace.getConfiguration('hello')));
    if(initConfig()){
      vsUtil.openTextDocument(CONFIG_PATH);
    }
  }));

  subscriptions.push(vscode.commands.registerCommand('ftp.remote.workspace.open', function () {
    getSelectedFTPConfig()
    .then(function(ftpConfig){
      var ftp = createFTP(ftpConfig, function(){
        getSelectedFTPFile(ftp, ftpConfig, ftpConfig.path, "Select the path want to remote open to workspace", [{label:".", description:ftpConfig.path}], "D", function selectItem(item, parentPath, filePath){
          if(isCurrentWorkspace(ftpConfig.host, parentPath))
          {
            vsUtil.msg("Already workspace");
            return;
          }
          downloadRemoteWorkspace(ftp, ftpConfig.host, parentPath, function(localPath){
            vsUtil.openFolder(localPath);
          });
        });
      });
    });
  }));

  

  subscriptions.push(vscode.commands.registerCommand('ftp.download', function () {
    var workspacePath = vsUtil.getWorkspacePath();
    if(!workspacePath)
    {
      vsUtil.msg("Please, open the workspace directory first.");
      return;
    }
    getSelectedFTPConfig(function(ftpConfig)
    {
      var ftp = createFTP(ftpConfig, function(){
        selectFirst(ftpConfig.path);
      });
      function selectFirst(path){
        getSelectedFTPFile(ftp, ftpConfig, path, "Select the file or directory want to download", [".", "*"], function(serverItem, serverParentPath, serverFilePath){
          getSelectedLocalPath(workspacePath, workspacePath, "Select the path want to download", ".", "D", selectItem); 
          function selectItem(item, parentPath, filePath){
            var isAll = serverItem.label === "*";
            var isDir = serverFilePath ? false : true;
            var localPath = isDir ? (isAll ? parentPath : pathUtil.join(parentPath, pathUtil.getFileName(serverParentPath))) : pathUtil.join(parentPath, serverItem.label);
            var remotePath = isDir ? serverParentPath + "/**" : serverFilePath;
            if(isAll || fileUtil.existSync(localPath))
            {
              confirmExist(ftp, isDir, parentPath, remotePath, localPath, isAll);
            }
            else
            {
              download(ftp, remotePath, localPath);
            }
          }
          function confirmExist(ftp, isDir, path, remotePath, localPath, isAll){
            var title = "Already exist " + (isDir ? "directory" : "file") + " '"+localPath+"'. Overwrite?";
            if(isAll) title = "If the file exists it is overwritten by force. Continue?";
            vsUtil.warning(title, "Back", "OK").then(function(btn){
              if(btn == "OK") download(ftp, remotePath, localPath, isAll);
              else if(btn == "Back") getSelectedLocalPath(path, workspacePath, "Select the path want to download", ".", "D", selectItem);
            });
          }
          function download(ftp, remotePath, localPath, isAll){
            ftp.download(remotePath, localPath, function(err){
              if(!err) 
              {
                if(!serverFilePath)
                  output(ftpConfig.name + " - Directory downloaded : " + localPath + (isAll ? "/*" : ""));
                selectFirst(pathUtil.getParentPath(remotePath));
              }
            })
          }       
        });
      }
    });
  }));

  subscriptions.push(vscode.commands.registerCommand('ftp.diff', function (item) {
      var localFilePath = vsUtil.getActiveFilePathAndMsg(item, "Please select a file to compare");
      if(!localFilePath) return;
      if(fileUtil.isDirSync(localFilePath))
      {
        vsUtil.msg("Select a file. The directory is impossible.");
        return;
      }
      getSelectedFTPConfig(function(ftpConfig)
      {
        var ftp = createFTP(ftpConfig, function(){
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
  }));

  subscriptions.push(vscode.commands.registerCommand('ftp.delete', function (item) {
    if(item)
    {
      var localFilePath = vsUtil.getActiveFilePath(item);
      if(isRemoteTempWorkspaceFile(localFilePath))
      {
        var ftpConfig = getFTPConfigFromRemoteTempPath(localFilePath);
        if(ftpConfig.config && ftpConfig.path)
        {
          var ftp = createFTP(ftpConfig.config, function(){
            ftp.rm(ftpConfig.path, function(err){
              if(!err)
              {
                fileUtil.rm(localFilePath, function(err){
                  output("Deleted : " + ftpConfig.path);
                });
              }
            });
          });
          return;
        }
      }
      else
      {
        vsUtil.msg("Context menu 'Delete' is only possible to remote file or directory.");
        return;
      }
    }
    getSelectedFTPConfig(function(ftpConfig)
    {
      var ftp = createFTP(ftpConfig, function(){
        selectFirst(ftpConfig.path);
      });
      function selectFirst(path){
        getSelectedFTPFile(ftp, ftpConfig, path, "Select the file or path want to delete", [{label:".", description:ftpConfig.path}], function selectItem(item, parentPath, filePath){
          var deletePath = filePath ? filePath : parentPath;
          vsUtil.warning("Are you sure you want to delete '"+deletePath+"'?", "Back", "OK")
          .then(function(btn){
            if(btn == "OK")
            {
              ftp.rm(deletePath, function(err){
                if(err) vsUtil.error(err.toString());
                else 
                {
                  output("Deleted : " + deletePath);
                  selectFirst(filePath ? parentPath : pathUtil.getParentPath(parentPath));
                }
              });
            }
            else if(btn == "Back") getSelectedFTPFile(ftp, ftpConfig, parentPath, "Select the file or path want to delete", [{label:".", description:parentPath}], selectItem);
          });
        });
      }
    }); 
  }));

  subscriptions.push(vscode.commands.registerCommand('ftp.mkdir', function () {
    getSelectedFTPConfig(function(ftpConfig)
    {
      var ftp = createFTP(ftpConfig, function(){
        selectFirst(ftpConfig.path);
      });
      function selectFirst(path){
        getSelectedFTPFile(ftp, ftpConfig, path, "Select the path want to create directory", [{label:".", description:ftpConfig.path}], "D", function selectItem(item, parentPath, filePath){
          create(ftp, parentPath);
        });
      }
      
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
                  if(!err) 
                  {
                    output("Create directory : " + p);
                    selectFirst(path);
                  }
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
  }));

  subscriptions.push(vscode.commands.registerCommand('ftp.open', function () {
    getSelectedFTPConfig(function(ftpConfig)
    {
      var ftp = createFTP(ftpConfig, function(){
          selectFirst(ftpConfig.path);
      });
      var column = 1;
      function selectFirst(path){
        getSelectedFTPFile(ftp, ftpConfig, path, "Select the file want to open", function(item, parentPath, filePath){
          console.log(parentPath);
          downloadOpen(ftp, ftpConfig, filePath, function(err){
            console.log("opened", column);
            if(!err && column <= 3) selectFirst(parentPath);
          }, column++);
        });
      }
    });
  }));
  
  subscriptions.push(vscode.commands.registerCommand('ftp.save', function (item) {
    var localFilePath = vsUtil.getActiveFilePathAndMsg(item, "Please select a file to upload");
    if(!localFilePath) return;
    var isForceUpload = item && item.fsPath ? true : false;
    var isDir = fileUtil.isDirSync(localFilePath);
    var isIncludeDir = true;  
     
    if(isDir)
    {
      var fileName = pathUtil.getFileName(localFilePath);
      selectUploadType(fileName, function(includeDir){
        isIncludeDir = includeDir;
        saveMain();
      });
    }
    else
    {
      saveMain();
    }
    function saveMain(){
      getSelectedFTPConfig(function(ftpConfig)
      {
        var ftp = createFTP(ftpConfig, function(){
          getSelectedFTPFile(ftp, ftpConfig, ftpConfig.path, "Select the path" + (isDir ? "" : " or file") + " want to save", [{label:".", description:ftpConfig.path}], (isDir ? "D" : null), selectItem);
        });
        
        function selectItem(item, path, filePath){
          if(filePath)
          {
            confirmExist(ftp, path, localFilePath, filePath);
          }
          else if(isIncludeDir)
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
          else
          {
            upload(ftp, ftpConfig, localFilePath, path);
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
    }
    
  }));

  for(var i=0; i<subscriptions.length; i++) context.subscriptions.push(subscriptions[i]);
}
exports.activate = activate;

// this method is called when your extension is deactivated
function deactivate() {
  closeFTPAll();
  destroy();
}
exports.deactivate = deactivate;

function destroy(isStart){
  var ws = vsUtil.getWorkspacePath();
  if(isStart && ws && vsUtil.getWorkspacePath().indexOf(REMOTE_WORKSPACE_TEMP_PATH) === -1)
  {
    fse.remove(REMOTE_WORKSPACE_TEMP_PATH, function(){});
  }
  fse.remove(REMOTE_TEMP_PATH, function(){});
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
        //addFTP(ftpConfig.host, ftp);
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

  // function addFTP(host, ftp){
  //   var result = true;
  //   var key = commonUtil.md5(host);
  //   ftps[key] = ftp;
  // }
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
      var isTimeout = false;
      var flag = setTimeout(function(){
        isTimeout = true;
        newInstance();
        if(cb) process.nextTick(cb);
      }, 3000);
      try{
        ftps[key].pwd(function(err, path){
          clearTimeout(flag);
          if(!isTimeout)
          {
            if(err) newInstance();
            if(cb) process.nextTick(cb, err ? undefined : ftps[key]);
          }
        });
      }catch(e){
        newInstance();
        if(cb)cb();
      }
    }
    else 
    {
      newInstance();
      if(cb) process.nextTick(cb);
    }
    function newInstance(){
      if(ftps[key]) ftps[key].close();
      ftps[key] = new EasyFTP();
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
  return new Promise(function(resolve, reject){
    var ftpsConfig = getConfig();
    var ftps = getFTPNames(ftpsConfig);
    if(ftps.length == 0)
    {
      vsUtil.msg('Check config file.');
      return;
    }
    vsUtil.pick(ftps, "Select FTP server", function(name) {
      if(cb)cb(getFTPConfig(ftpsConfig, name));
      else resolve(getFTPConfig(ftpsConfig, name));
    });
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
  var tempPath;
  if(remoteTempPath.indexOf(REMOTE_TEMP_PATH) === 0)
  {
    tempPath = REMOTE_TEMP_PATH;
  }
  else if(remoteTempPath.indexOf(REMOTE_WORKSPACE_TEMP_PATH) === 0)
  {
    tempPath = REMOTE_WORKSPACE_TEMP_PATH;
  }
  if(tempPath)
  {
    var host = remoteTempPath.substring(tempPath.length + 1);
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
function downloadOpen(ftp, ftpConfig, remotePath, cb, column){
  download(ftp, ftpConfig, remotePath, function(err, localPath){    
    if(!err)
    {
      fs.stat(localPath, function(err){
        if(!err)
        { 
          vsUtil.open(localPath, column, function(){
            if(cb)cb();
          });
        }
        else if(cb)cb(err);
      });
    }
    else if(cb)cb(err);
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
function selectUploadType(dirName, cb){
  vsUtil.pick([{label:dirName, description:"Including the selected directory", type:'d'}, {label:dirName + "/**", description:"Exclude the selected directory. If exist file, force overwrite.", type:'f'}], "Choose the uploaded type", function(item){
    cb(item.type === 'd');
  });
}
function getRemoteWorkspace(host, remotePath){
  return pathUtil.join(REMOTE_WORKSPACE_TEMP_PATH, commonUtil.md5(host), remotePath);
}
function isCurrentWorkspace(host, remotePath){
  var localPath = getRemoteWorkspace(host, remotePath);
  return localPath == vsUtil.getWorkspacePath();
}
function downloadRemoteWorkspace(ftp, host, remotePath, cb, notMsg, notRecursive){
  var localPath = getRemoteWorkspace(host, remotePath);
  //if(fileUtil.existSync(localPath)) fileUtil.rmSync(localPath);
  if(!notMsg) vsUtil.msg("Please wait......Remote Info downloading...");
  removeRefreshRemoteTimer();
  emptyDownload(remotePath, localPath, function(err){
    setRefreshRemoteTimer();
    if(cb)cb(localPath);
  });

  function emptyDownload(remotePath, localPath, cb){    
    //console.log("emptyDownload: ", remotePath, localPath);
    ftp.ls(remotePath, function(err, remoteFileList){
      if(err && cb) cb();
      else
      {
        if(remoteFileList.length > 0) fileUtil.mkdirSync(localPath);
        fileUtil.ls(localPath, function(err, localFileList){
          loop(remoteFileList, function(i, value, next){
            var newFilePath = pathUtil.join(localPath, value.name);
            if(value.type === 'd')
            {              
              if(notRecursive) next();
              else
              {
                fileUtil.mkdirSync(newFilePath);
                emptyDownload(pathUtil.join(remotePath, value.name), newFilePath, function(){
                  next();
                });
              }
            }
            else
            {
              fileUtil.stat(newFilePath, function(stat){
                if(!stat)
                {
                  fileUtil.writeFile(newFilePath, "", next);
                }
                else next();
              });
            }            
          }, function(err){
            deleteDiff(localFileList, remoteFileList);
            if(cb) cb(err);
          });
        }); 
      }
    });
  } 
  function deleteDiff(localList, remoteList){
    for(var i=0, ilen=localList.length; i<ilen; i++)
    {
      var exist = false;
      for(var j=0, jlen=remoteList.length; j<jlen; j++)
      {
        if(localList[i].name === remoteList[j].name)
        {
          exist = true;
          break;
        }
      }
      if(!exist && localList[i].size === 0)
      {
        fileUtil.rmSync(localList[i].path); 
      }
    }
  } 
}
function isRemoteTempWorkspaceFile(path){
  return path.indexOf(REMOTE_WORKSPACE_TEMP_PATH) === 0;
}
function autoRefreshRemoteTempFiles(){
  var workspacePath = vsUtil.getWorkspacePath();
  if(workspacePath)
  {
    var ftpConfig = getFTPConfigFromRemoteTempPath(workspacePath);
    if(ftpConfig.config && ftpConfig.path)
    {      
      var ftp = createFTP(ftpConfig.config, function(){        
        downloadRemoteWorkspace(ftp, ftpConfig.config.host, ftpConfig.path, function(){
        }, true);
      });
    }
  }
}
function removeRefreshRemoteTimer(){
  clearTimeout(remoteRefreshFlag);
}
function setRefreshRemoteTimer(isNow){
  removeRefreshRemoteTimer();
  remoteRefreshFlag = setTimeout(autoRefreshRemoteTempFiles, isNow ? 0 : 1000 * 60 * 3);
}