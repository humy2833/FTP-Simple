var vscode = require('vscode');
var fs = require('fs');
var fse = require('fs-extra');
var loop = require('easy-loop');
var minimatch = require('minimatch');
var filesize = require('filesize');
var pathUtil = require('./lib/path-util');
var fileUtil = require('./lib/file-util');
var commonUtil = require('./lib/common-util');
var vsUtil = require('./lib/vs-util');
var cryptoUtil = require('./lib/crypto-util');
var EasyFTP = require('easy-ftp');
var chokidar = require('chokidar');
var outputChannel = null;
var root = null;
var ftps = {};
var remoteRefreshFlag = false;
var remoteRefreshStopFlag = false;
var watcher = null;
var waitList = [];
const CONFIG_NAME = "ftp-simple.json";
const CONFIG_FTP_TEMP = "/ftp-simple/remote-temp";
const CONFIG_FTP_WORKSPACE_TEMP = "/ftp-simple/remote-workspace-temp";
const CONFIG_PATH = vsUtil.getConfigPath(CONFIG_NAME);
const CONFIG_PATH_TEMP = vsUtil.getConfigPath("ftp-simple-temp.json");
const REMOTE_TEMP_PATH = vsUtil.getConfigPath(CONFIG_FTP_TEMP);
const REMOTE_WORKSPACE_TEMP_PATH = vsUtil.getConfigPath(CONFIG_FTP_WORKSPACE_TEMP);

function activate(context) {
  var subscriptions = [];
  console.log("ftp-simple start");
  outputChannel = vsUtil.getOutputChannel("ftp-simple");
  destroy(true);
  
  setRefreshRemoteTimer(true);
  //startWatch();
  
  
  vscode.workspace.onDidSaveTextDocument(function(event){
    //console.log("onDidSaveTextDocument : ", event);
    updateToRemoteTempPath(event.fileName);
  });
  vscode.workspace.onDidCloseTextDocument(function(event){    
    //파일 닫을때, 파일 형식 바뀔때
    //console.log("onDidCloseTextDocument 파일 닫을때 : ", event, vsUtil.getActiveFilePathAll());
    
    var remoteTempPath = pathUtil.normalize(event.fileName);
    if(!vsUtil.isChangeTextDocument(remoteTempPath)) return;    
    //console.log("파일 닫기 : ", remoteTempPath);
    var ftpConfig = getFTPConfigFromRemoteTempPath(remoteTempPath);
    if(isRemoteTempWorkspaceFile(remoteTempPath))
    {      
      var stat = fileUtil.statSync(remoteTempPath);
      if(stat && stat.size > 0)
      {
        runAfterCheck(remoteTempPath, function(){
          fileUtil.writeFile(remoteTempPath, "", function(){
            //console.log("파일 삭제 : ", remoteTempPath);
          });
        });
      }
      // else
      // {
      //   var ftp = createFTP(ftpConfig.config, function(){
      //     ftp.rm(ftpConfig.path, function(err){
      //       if(!err) output("Deleted : " + ftpConfig.path);
      //     });
      //   });
      // }
    }
    else if(ftpConfig.config && ftpConfig.path)
    {
      var path = pathUtil.normalize(event.fileName);
      runAfterCheck(path, function(){
        fileUtil.rm(path);
      });
    }
    else if(CONFIG_PATH_TEMP == remoteTempPath)
    {
      fileUtil.rm(CONFIG_PATH_TEMP);
    }
  });

  // vscode.workspace.onDidChangeTextDocument(function(event){
  //   //소스 수정할때,파일 닫을때, 파일 형식 바뀔때
  //   //console.log("onDidChangeTextDocument : ", event);
  // });
  
  //vscode.workspace.onDidOpenTextDocument(function(event){
  vscode.window.onDidChangeActiveTextEditor(function(event){
    //console.log("onDidOpenTextDocument : ", event);
    //if(!event || !event.document)return;   
    if(!(event && event._documentData && event._documentData._uri && event._documentData._uri.fsPath))return; 
    var remoteTempPath = pathUtil.normalize(event._documentData._uri.fsPath);//(event.fileName);
    if(!fileUtil.existSync(remoteTempPath)) return;
    
    //console.log("파일 열기 : ", remoteTempPath);
    var ftpConfigFromTempDir = getFTPConfigFromRemoteTempPath(remoteTempPath);  
    var stat = fileUtil.statSync(remoteTempPath);
    if(isRemoteTempWorkspaceFile(remoteTempPath) && stat.size === 0)
    {
      createFTP(ftpConfigFromTempDir.config, function(ftp){
        var fileName = pathUtil.getFileName(remoteTempPath);
        if(fileName.indexOf("[DIR]") === 0)
        {
          var realRemotePath = pathUtil.join(pathUtil.getParentPath(ftpConfigFromTempDir.path), fileName.replace("[DIR] ", ""));
          downloadRemoteWorkspace(ftp, ftpConfigFromTempDir.config, realRemotePath, function(err){
            fileUtil.rm(remoteTempPath);
          }, true, 1);
        }
        else if(new Date().getTime() - stat.date.getTime() >= 100)
        {
          ftp.download(ftpConfigFromTempDir.path, remoteTempPath, function(){
            //console.log("파일 다운로드 : ", remoteTempPath);
            if(watcher)
            {
              setTimeout(function(){
                downloadRemoteWorkspace(ftp, ftpConfigFromTempDir.config, pathUtil.getParentPath(ftpConfigFromTempDir.path), function(localPath){}, true, 1);
              }, 100);
            }
          });
        }
        else  //new file
        {
          ftp.exist(ftpConfigFromTempDir.path, function(bool){
            if(bool)
            {
              vsUtil.confirm("Remote server already exist file '"+ftpConfigFromTempDir.path+"'. Overwrite?", "OK").then(function(btn){
                if(btn == "OK")
                {
                  up();
                }
              });
            }
            else
            {
              up();
            }
          });
          function up(){
            ftp.upload(remoteTempPath, ftpConfigFromTempDir.path, function(err){
              //console.log("파일 업로드 : ", remoteTempPath);
              if(err) output("upload fail : " + ftpConfigFromTempDir.path + " => " + err.message);
            });
          }
        }
      });
    }
    if(ftpConfigFromTempDir.config && ftpConfigFromTempDir.path && ftpConfigFromTempDir.config.autosave === true)
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
    var configSet = initConfig();
    if(configSet.result){
      fileUtil.writeFile(CONFIG_PATH_TEMP, JSON.stringify(configSet.json, null, '\t'), function(){
        vsUtil.openTextDocument(CONFIG_PATH_TEMP);
      });
    }
  }));

  subscriptions.push(vscode.commands.registerCommand('ftp.remote.workspace.open', function () {
    getSelectedFTPConfig().then(function(ftpConfig){
      createFTP(ftpConfig, function(ftp){
        getSelectedFTPFile(ftp, ftpConfig, ftpConfig.path, "Select the path want to remote open to workspace", [{label:".", description:ftpConfig.path}], "D", function selectItem(item, parentPath, filePath){
          if(isCurrentWorkspace(ftpConfig, parentPath))
          {
            vsUtil.msg("Already workspace");
            return;
          }
          fileUtil.rm(getRemoteWorkspace(ftpConfig, parentPath), function(){
            downloadRemoteWorkspace(ftp, ftpConfig, parentPath, function(localPath){
              vsUtil.openFolder(localPath);
            }, false, 1);
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
              if(err) output("download fail : " + remotePath + " => " + err.message);
              else 
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
    var baseProjects = getProjectPathInConfig();
    if(baseProjects)
    {
      getSelectedProjectFTPConfig(baseProjects, 'DIFF', function(item){      
        if(item === 'SERVER ALL')
        {
          getSelectedFTPConfig(diff);
        }
        else if(typeof item === 'object')
        {
          var workspacePath = vsUtil.getWorkspacePath();
          createFTP(item, function(ftp){
            var remotePath = pathUtil.join(item.remote, pathUtil.getRelativePath(workspacePath, localFilePath));
            ftp.exist(remotePath, function(result){
              if(result)
              {
                downloadAndDiff(ftp, item, remotePath);              
              }
              else vsUtil.error("The file does not exist on the server.");
            });
          });
        }
      });
    } 
    else
    {
      getSelectedFTPConfig(diff);
    }
    

    function diff(ftpConfig)
    {
      createFTP(ftpConfig, function(ftp){
        getSelectedFTPFile(ftp, ftpConfig, ftpConfig.path, "Select the file want to compare", function selectItem(item, parentPath, filePath){
          downloadAndDiff(ftp, ftpConfig, filePath);
        });
      });
    }
    function downloadAndDiff(ftp, ftpConfig, filePath){
      download(ftp, ftpConfig, filePath, function(err, path){
        if(!err)
        {
          vsUtil.diff(localFilePath, path);
        }
      });
    }
  }));
    
  subscriptions.push(vscode.commands.registerCommand('ftp.delete', function (item) {
    if(item)
    {
      var localFilePath = vsUtil.getActiveFilePath(item);
      if(deleteToRemoteTempPath(localFilePath)) return;
    }
    else if(item === null)  //워크스페이스 선택
    {

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
          createRemoteDirecotry(ftp, parentPath, "", function(){
            selectFirst(parentPath);
          });
        });
      }
      /*
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
      */
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
          downloadOpen(ftp, ftpConfig, filePath, function(err){            
            if(!err && column <= 3) selectFirst(parentPath);
          }, column++);
        });
      }
    });
  }));
  
  subscriptions.push(vscode.commands.registerCommand('ftp.save', function (item) {
    var isForceUpload = item && item.fsPath ? true : false;
    var localFilePath = vsUtil.getActiveFilePathAndMsg(item, "Please select a file to upload");
    var workspacePath = vsUtil.getWorkspacePath();
    if(item === null && workspacePath) 
    {
      localFilePath = workspacePath;
      isForceUpload = true;
    }
    if(!localFilePath) return;
    
    var baseProjects = getProjectPathInConfig();
    var isDir = fileUtil.isDirSync(localFilePath);
    var isIncludeDir = true;
    getSelectProject();

    function getSelectProject(){
      if(baseProjects)
      {
        getSelectedProjectFTPConfig(baseProjects, 'SAVE', function(item){
          if(typeof item === 'object')
          {
            isForceUpload = true;
            createFTP(item, function(ftp){
              upload(ftp, item, localFilePath, pathUtil.join(item.remote, pathUtil.getRelativePath(workspacePath, localFilePath)));
            });
          }
          else if(item === 'SERVER ALL')
          {
            getSelectedFTPConfig(saveMain);
          }
          else if(item === 'SAVE ALL')
          {
            isForceUpload = true;
            var backupName = commonUtil.getNow().replace(/[^0-9]/g, '');
            loop(baseProjects, function(i, value, next){
              var ftp = createFTP(value.config, function(){
                var remotePath = pathUtil.join(value.path.remote, pathUtil.getRelativePath(workspacePath, localFilePath));
                if(value.config.backup)
                {
                  getBackupList(localFilePath, remotePath, function(backupList, realLocalPath){
                    backup(ftp, value.config, backupList, backupName, function(err){
                      var tempBackup = value.config.backup;
                      delete value.config.backup;
                      upload(ftp, value.config, localFilePath, remotePath, backupName, function(){
                        value.config.backup = tempBackup;
                        next();
                      });
                    });
                  });
                }
                else
                {
                  upload(ftp, value.config, localFilePath, remotePath, backupName, next);
                }
              });
            });
          }
          else if(item.indexOf('WAIT') === 0)
          {
            if(item.indexOf('ALL') === -1)
            {
              addWaitList(localFilePath, isDir);
            }
            else
            {
              pickWaitList(function(list){
                if(list && list.length)
                {
                  getSelectedProjectFTPConfig(baseProjects, 'SAVE_WAIT_LIST', function(item){
                    var backupName = commonUtil.getNow().replace(/[^0-9]/g, '');
                    if(typeof item === 'object')
                    {
                      var ftp = createFTP(item, function(){
                        if(item.backup)
                        {
                          loop(list, function(i, value, next){
                            getBackupList(value.path, pathUtil.join(item.remote, value.label), function(backupList, realLocalPath){
                              backup(ftp, item, backupList, backupName, function(err){
                                next();
                              });
                            });
                          }, function(err){
                            delete item.backup;
                            loop(list, function(i, value, next){
                              upload(ftp, item, value.path, pathUtil.join(item.remote, value.label), backupName, next);
                            });
                          });
                        }
                        else
                        {
                          loop(list, function(i, value, next){
                            upload(ftp, item, value.path, pathUtil.join(item.remote, value.label), backupName, next);
                          });
                        }
                      });
                    }
                    else if(item === 'SAVE ALL')
                    {
                      loop(baseProjects, function(i, value, next){
                        var ftp = createFTP(value.config, function(){
                          if(value.config.backup)
                          {
                            loop(list, function(j, v, next){
                              getBackupList(v.path, pathUtil.join(value.path.remote, v.label), function(backupList, realLocalPath){
                                backup(ftp, value.config, backupList, backupName, function(err){
                                  next();
                                });
                              });  
                            }, function(err){
                              var tempBackup = value.config.backup;
                              delete value.config.backup;
                              loop(list, function(j, v, next){
                                upload(ftp, value.config, v.path, pathUtil.join(value.path.remote, v.label), backupName, next);
                              }, function(err){
                                value.config.backup = tempBackup;
                                next();
                              });
                            });
                          }
                          else
                          {
                            loop(list, function(j, v, next){
                              upload(ftp, value.config, v.path, pathUtil.join(value.path.remote, v.label), backupName, next);
                            }, function(err){
                              next();
                            });
                          }
                        });
                      });
                    }
                  });
                }
              });
            }
          }          
        });
      }
      else 
      {
        if(isDir)
        {
          var fileName = pathUtil.getFileName(localFilePath);
          selectUploadType(fileName, function(includeDir){
            isIncludeDir = includeDir;
            getSelectedFTPConfig(saveMain);
          });
        }
        else
        {
          getSelectedFTPConfig(saveMain);
        }
      }
    }
    function saveMain(ftpConfig){
      var ftp = createFTP(ftpConfig, function(){
        getSelectedFTPFile(ftp, ftpConfig, ftpConfig.path, "Select the path" + (isDir ? "" : " or file") + " want to save", [{label:".", description:ftpConfig.path}, "= CREATE DIRECTORY ="], (isDir ? "D" : null), selectItem);
      });
      
      function selectItem(item, path, filePath){
        if(filePath)
        {
          if(ftpConfig.confirm === false) 
          {
            upload(ftp, ftpConfig, localFilePath, path, function(err){
              if(!err)
              {
                hideAndOpen(ftp, ftpConfig, path);
              }
            });
          }
          else confirmExist(ftp, ftpConfig, path, localFilePath, filePath);
        }
        else if(isIncludeDir)
        {
          var fileName = pathUtil.getFileName(localFilePath);
          var isInput = false;            
          //existProc(fileName);
          vsUtil.input({value : fileName
            , placeHolder : "Write the " + (isDir ? "directory" : "file") + " name"
            , prompt : "Write the " + (isDir ? "directory" : "file") + " name"
            , validateInput : function(value){
                isInput = /[\\\/|*?<>:"]/.test(value) ? true : null;
                //console.log("validateInput:"+value+"$",isInput);
                return isInput;
            }
          }).then(function(name){
            //console.log("then:"+name+"$", isInput);
            if(name) existProc(name);
            else 
            {
              if(isInput) vsUtil.error("Filename to include inappropriate words.");
            }
          });

          function existProc(fileName){
            var rPath = pathUtil.join(path, fileName);
            if(ftpConfig.confirm === false)
            {
              upload(ftp, ftpConfig, localFilePath, rPath, function(err){
                if(!err)
                {
                  hideAndOpen(ftp, ftpConfig, rPath);
                }
              });
            }
            else
            {
              exist(ftp, path, fileName, function(result){
                if(result) confirmExist(ftp, ftpConfig, path, localFilePath, rPath);
                else
                {
                  upload(ftp, ftpConfig, localFilePath, rPath, function(err){
                    if(!err)
                    {
                      hideAndOpen(ftp, ftpConfig, rPath);
                    }
                  });
                }
              });
            }
          }
        }
        else
        {
          upload(ftp, ftpConfig, localFilePath, path, function(err){
            if(!err)
            {
              hideAndOpen(ftp, ftpConfig, path);
            }
          });
        }
      }
    }
    function hideAndOpen(ftp, ftpConfig, remotePath){
      if(!isForceUpload)
      {
        vsUtil.hide();
        downloadOpen(ftp, ftpConfig, remotePath);
      }
    }    
    function confirmExist(ftp, ftpConfig, path, localPath, remotePath){
      vsUtil.warning("Already exist " + (isDir ? "directory" : "file") + " '"+remotePath+"'. Overwrite?", "Back", "OK").then(function(btn){
        if(btn == "OK") upload(ftp, ftpConfig, localPath, remotePath);
        else if(btn == "Back") getSelectedFTPFile(ftp, ftpConfig, path, "Select the path" + (isDir ? "" : " or file") + " want to save", [{label:".", description:path}], selectItem);
      });
    }    
  }));

  for(var i=0; i<subscriptions.length; i++) context.subscriptions.push(subscriptions[i]);
}
exports.activate = activate;

// this method is called when your extension is deactivated
function deactivate() {
  closeFTP();
  destroy();
}
exports.deactivate = deactivate;

function destroy(isStart){
  // var ws = vsUtil.getWorkspacePath();
  // if(isStart && ws && vsUtil.getWorkspacePath().indexOf(REMOTE_WORKSPACE_TEMP_PATH) === -1)
  // {
  //   fse.remove(REMOTE_WORKSPACE_TEMP_PATH, function(){});
  // }
  fse.remove(REMOTE_TEMP_PATH, function(){});
}
function getPassword(ftpConfig, cb){
  if(!ftpConfig.password && !ftpConfig.privateKey)
  {
    vsUtil.input({password:true, placeHolder:'Enter the FTP connect password'}).then(function(item){
      if(item)
      {
        ftpConfig.password = item;
        if(cb) cb();
      }
      else closeFTP(ftpConfig.host);
    });
  }
  else if(cb)
  {
    cb()
  }
}
function createFTP(ftpConfig, cb){
  var ftp = getFTP(ftpConfig.host, function(result){
    if(result)
    {
      if(cb) cb(result);
    }
    else
    {
      getPassword(ftpConfig, function(){
        var TRY = 5;
        var count = 0;
        //var ftp = new EasyFTP();
        output(ftpConfig.name + " - " + "FTP Connecting...");
        try{ftp.connect(ftpConfig);}catch(e){console.log("catch : ", e);}
        ftp.on("open", function(){        
          //count = TRY;
          output(ftpConfig.name + " - " + "FTP open!!");
          //addFTP(ftpConfig.host, ftp);
          if(cb) cb(ftp);
        });
        ftp.on("close", function(){
          output(ftpConfig.name + " - " + "FTP close!!");
          deleteFTP(ftpConfig.host);
        });
        ftp.on("error", function(err){
          output(ftpConfig.name + " - " + err.message);
          if(String(err).indexOf("Timed out while waiting for handshake") > -1) TRY = 0;
          else if(String(err).indexOf("530 Please login with USER and PASS") > -1) TRY = 0;
          //console.log("error 발생", count, TRY, String(err));
          if(count < TRY)
          {
            count++;
            setTimeout(function(){
              output(ftpConfig.name + " - " + "FTP Connecting try...");
              createFTP(ftpConfig, cb);//ftp.connect(ftpConfig);
            }, 200);
          }
          else if(count == TRY)
          {
            var s = String(err);
            //if(/^Error\: \d+ /.test(s)) s = s.replace(/^Error\: \d+ /, '');
            vsUtil.error(ftpConfig.name + " - Connect fail : " + s);
            closeFTP(ftpConfig.host);
          }
        });
        ftp.on("upload", function(path){
          output(ftpConfig.name + " - " + "Uploaded : " + path);
        });
        ftp.on("download", function(path){
          output(ftpConfig.name + " - " + "Downloaded : " + path);
        });
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
function closeFTP(host){
  if(host)
  {
    var key = commonUtil.md5(host);
    try{ftps[key].close();}catch(e){}
    try{delete ftps[key];}catch(e){}
  } 
  else
  {
    for(var i in ftps)
    {    
      try{ftps[i].close();}catch(e){}
      delete ftps[i];
    }
  }
}
function setDefaultConfig(config){
  for(var i=0; i<config.length; i++)
  {
    if(config[i].autosave === undefined) config[i].autosave = true;
    if(config[i].confirm === undefined) config[i].confirm = true;
    if(config[i].path === undefined) config[i].path = "/";
  }
  return config;
}
function writeConfigFile(json){
  fileUtil.writeFileSync(CONFIG_PATH, cryptoUtil.encrypt(JSON.stringify(json, null, '\t')));
}
function initConfig(){
  var result = true;
  var json = vsUtil.getConfig(CONFIG_NAME);
  try{
    json = cryptoUtil.decrypt(json);
    json = JSON.parse(json);
  }catch(e){
    //암호화 안된 파일일때
    try{
      json = JSON.parse(json);
      writeConfigFile(json);
    }catch(ee){
      if(json === undefined){
        //설정 없을때
        json = [{name:"localhost", host:"", port:21, type:"ftp", username:"", password:"", path:"/"}];
        writeConfigFile(json);
      }else{
        vsUtil.error("Check Simple-FTP config file syntax.");
         fileUtil.writeFile(CONFIG_PATH_TEMP, json, function(){
           vsUtil.openTextDocument(CONFIG_PATH_TEMP);
         });
        result = false;
      }
    }   
  }
  json = setDefaultConfig(json);
  return {result:result, json:json};
  /*
  try{
    var json = vsUtil.getConfig(CONFIG_NAME, JSON.parse);
    if(json === undefined){
      json = [{name:"localhost", host:"", port:21, type:"ftp", username:"", password:"", path:"/"}];
      var str = JSON.stringify(json, null, "\t");
      fs.writeFileSync(CONFIG_PATH, cryptoUtil.encrypt(str));
    }
    json = setDefaultConfig(json);
  }catch(e){
    //console.log(e);
    vsUtil.msg("Check config file syntax.");
    result = false;
  }
  return {result:result, json:json};
  */
}
function getConfig(){
  var json = {};
  var config = initConfig();
  if(config.result)
  {
    json = config.json;
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
function getFTPConnectInfo(config, name){
  for(var i in config)
  {
    if(config[i]["name"] == name || makeTempName(config[i]) == name)
    {
      return config[i];
    }
  }
  return null;
}
function output(str){
  vsUtil.output(outputChannel, str);
}
function getFTPConfig(ftpsConfig, name){
  var ftpConfig = getFTPConnectInfo(ftpsConfig, name);
  if(ftpConfig)
  {
    if(!ftpConfig.path) ftpConfig.path = "/";
    else ftpConfig.path = pathUtil.normalize(ftpConfig.path);
  }  
  return ftpConfig;
}
function getSelectedProjectFTPConfig(projects, type, cb){
  const ALL = '= SHOW ALL SERVER LIST =';
  const SAVE_ALL = '= SAVE ALL PROJECT =';
  const WAIT = '= WAIT =';
  const WAIT_ALL = '= SHOW ALL WAIT LIST =';
  var list = [];
  for(let i=0; i<projects.length; i++)
  {
    list.push({label:projects[i].config.name, description:projects[i].path.remote, idx:i});
  }  
  if(type === 'SAVE_WAIT_LIST')
  {
    list.push({label:SAVE_ALL, description:'Unconditionally overwrite'});
  }
  else
  {
    if(type === 'SAVE') 
    {
      list.push({label:WAIT, description:'Save the file path to the waiting list'});
      if(waitList.length) list.push({label:WAIT_ALL, description:'Shows all waiting list'});
      list.push({label:SAVE_ALL, description:'Unconditionally overwrite'});
    }
    list.push({label:ALL});
  }
 
  vsUtil.pick(list, 'Select the project to ' + type.toLowerCase()).then(function(item){
    if(item)
    {
      if(item.label == SAVE_ALL)
      {
        if(cb) cb('SAVE ALL');
      }
      else if(item.label == WAIT)
      {
        if(cb) cb('WAIT');
      }
      else if(item.label == WAIT_ALL)
      {
        if(cb) cb('WAIT ALL');
      }
      else if(item.idx != undefined)
      {
        var o = projects[item.idx].config;
        o.remote = item.description; 
        if(cb)cb(o);
      }
      else if(item.label == ALL)
      {
        if(cb) cb('SERVER ALL');
      }
    }
  });
}
function getSelectedFTPConfig(cb){
  return new Promise(function(resolve, reject){
    var ftpsConfig = getConfig();
    var ftps = getFTPNames(ftpsConfig);
    if(ftps.length == 0)
    {
      vsUtil.error('Check Simple-FTP config file syntax.');
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
        }else if(item.label === "= CREATE DIRECTORY ="){
          createRemoteDirecotry(ftp, path, "", function(){
            getSelectedFTPFile(ftp, ftpConfig, path, placeHolder, addItems, filter, cb);
          });
        }else{
          if(cb)cb(item, path, item.type ? pathUtil.join(path, item.label) : null);
        }
      }
    });
  });
}
function createRemoteDirecotry(ftp, path, value, cb){
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
            if(btn) createRemoteDirecotry(ftp, path, name, cb);
          });
        }
        else 
        {
          var p = pathUtil.join(path, name);
          ftp.mkdir(p, function(err){
            if(!err) 
            {
              output("Create directory : " + p);
              cb();
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
        cb();
      }
    }
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
    var tempDirName = remoteTempPath.substring(tempPath.length + 1);
    remotePath = tempDirName.substring(tempDirName.indexOf("/"));
    tempDirName = tempDirName.substring(0, tempDirName.indexOf("/"));    
    if(!tempDirName)
    {
      tempDirName = remotePath;
      remotePath = "/";
    }
    ftpConfig = getFTPConfig(getConfig(), tempDirName);
  }
  return {config : ftpConfig, path : remotePath};
}
function getBackupList(localPath, remotePath, cb){  
  fileUtil.isDir(localPath, function(err, isDir){
    if(isDir)
    {
      var wsLen = vsUtil.getWorkspacePath().length;
      var folder = localPath.substring(wsLen);    
      wsLen += folder.length;        
      fileUtil.ls(localPath, function(err, list){
        list.forEach(function(v,i,arr){
          arr[i] = pathUtil.join(remotePath, v.path.substring(wsLen));
        });
        cb(list, localPath + "/**");
      }, true);
    }
    else
    {
      cb([remotePath], localPath);
    }
  });
}
function upload(ftp, ftpConfig, localPath, remotePath, backupName, cb){
  if(typeof backupName === 'function')
  {
    cb = backupName;
    backupName = undefined;
  }
  if(ftpConfig.backup)
  {
    getBackupList(localPath, remotePath, function(backupList, realLocalPath){
      var isDir = localPath != realLocalPath;
      backup(ftp, ftpConfig, backupList, backupName, function(err){
        localPath = realLocalPath;
        main(isDir);
      });
    });
  }
  else
  {
    fileUtil.isDir(localPath, function(err, isDir){
      if(isDir) localPath = localPath + "/**";
      main(isDir);
    });
  }
  function main(isDir){
    ftp.upload(localPath, remotePath, function(err){
      // if(!err && !isForceUpload)
      // {
      //   vsUtil.hide();
      //   downloadOpen(ftp, ftpConfig, remotePath);
      // }
      if(!err && isDir) output(ftpConfig.name + " - Directory uploaded : " + remotePath);
      if(err) output("upload fail : " + remotePath + " => " + err.message);
      if(cb) cb(err);
    });
  }
}
/*
function isNewerThenLocal(ftp, ftpConfig, localPath, remotePath, cb){
  var parentPath = pathUtil.getParentPath(remotePath);
  var fileName = pathUtil.getFileName(remotePath);
  //console.log(parentPath, fileName);
  loop.parallel({
    local : function(cb){
      fileUtil.stat(localPath, function(stat){
        cb(null, stat.date.getTime());
      });
    },
    remote : function(cb){
      let remoteTime = 0;
      ftp.ls(parentPath, function(err, list){
        if(!err && list && list.length)
        {
          list.some(function(v){
            if(v.name == fileName)remoteTime = v.date.getTime();
            return v.name == fileName;
          });
        }
        cb(null, remoteTime);
      });
    }
  }, function(err, results){

  });
}
*/
function download(ftp, ftpConfig, remotePath, cb){
  var localPath = pathUtil.join(REMOTE_TEMP_PATH, makeTempName(ftpConfig), remotePath);
  ftp.download(remotePath, localPath, function(err){
    if(err) output("download fail : " + remotePath + " => " + err.message);
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
function makeTempName(ftpConfig){
  return commonUtil.md5(ftpConfig.host + ftpConfig.name + ftpConfig.path);
}
function getRemoteWorkspace(ftpConfig, remotePath){
  return pathUtil.join(REMOTE_WORKSPACE_TEMP_PATH, makeTempName(ftpConfig), remotePath);
}
function isCurrentWorkspace(ftpConfig, remotePath){
  var localPath = getRemoteWorkspace(ftpConfig, remotePath);
  return localPath == vsUtil.getWorkspacePath();
}
function downloadRemoteWorkspace(ftp, ftpConfig, remotePath, cb, notMsg, notRecursive){
  var localPath = getRemoteWorkspace(ftpConfig, remotePath);
  //if(fileUtil.existSync(localPath)) fileUtil.rmSync(localPath);
  if(!notMsg) vsUtil.msg("Please wait......Remote Info downloading... You can see 'output console'");
  //vsUtil.msg("Please wait......Remote Info downloading... You can see 'output console'");
  removeRefreshRemoteTimer();
  emptyDownload(remotePath, localPath, function(err){ 
    setRefreshRemoteTimer();
    if(cb)cb(localPath);
  }, typeof notRecursive === 'number' ? notRecursive : undefined);

  function emptyDownload(remotePath, localPath, cb, depth){
    if(remoteRefreshStopFlag)
    {
      cb();
      return;
    }    
    ftp.ls(remotePath, function(err, remoteFileList){
      if(err && cb || remoteRefreshStopFlag) cb();
      else
      {
        //if(remoteFileList.length > 0) 
        //{
          fileUtil.mkdirSync(localPath);
        //}
        // var last = remoteFileList.indexOf("node_modules");
        // if(last > -1)
        // {
        //   remoteFileList = remoteFileList.concat(remoteFileList.splice(last, 1));
        // }
        fileUtil.ls(localPath, function(err, localFileList){
          loop(remoteFileList, function(i, value, next){
            if(remoteRefreshStopFlag)
            {
              next();
              return;
            }
            var remoteRealPath = pathUtil.join(remotePath, value.name);
            if(isIgnoreFile(ftpConfig, remoteRealPath))
            {
              next();
            }
            else
            {
              var newFilePath = pathUtil.join(localPath, value.name);
              //수정본 시작
              fileUtil.stat(newFilePath, function(stat){
                if(!stat)
                {
                  if(value.type === 'd')
                  {
                    if(typeof notRecursive === 'number' && depth > 0)
                    {
                      emptyDownload(remoteRealPath, newFilePath, next, typeof depth === 'number' ? depth-1 : undefined);
                    }
                    else
                    {
                      newFilePath = pathUtil.join(localPath, "[DIR] " + value.name);
                      fileUtil.stat(newFilePath, function(stat){
                        if(!stat)
                        {
                          make(newFilePath);
                        }
                      });
                    }
                  }
                  else
                  {
                    make(newFilePath);
                  }
                }
                next();
              });
              //수정본 끝

              /*기존
              if(value.type === 'd')
              {
                fileUtil.mkdir(newFilePath, function(){
                  // if(notRecursive === true || depth === 0) next();
                  // else emptyDownload(pathUtil.join(remotePath, value.name), newFilePath, next, typeof depth === 'number' ? depth-1 : undefined);
                });
                if(notRecursive !== true && depth !== 0)
                {
                  emptyDownload(remoteRealPath, newFilePath, next, typeof depth === 'number' ? depth-1 : undefined);
                }
                else next();
              }
              else
              {
                fileUtil.stat(newFilePath, function(stat){
                  if(!stat)
                  {
                    output("Remote info download : " + newFilePath); 
                    fileUtil.writeFile(newFilePath, "");
                  }
                });
                next();
              }
              */
            }           
          }, function(err){
            //if(!remoteRefreshStopFlag) deleteDiff(localFileList, remoteFileList);
            if(cb) cb(err);
          });
        }); 
      }
    });
  } 
  function make(newFilePath){
    output("Remote info download : " + newFilePath); 
    fileUtil.writeFile(newFilePath, "");
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
      if(!exist)// && localList[i].size === 0
      {
        var docs = vsUtil.getActiveFilePathAll();
        if(docs.indexOf(localList[i].path) === -1)
        {
          fileUtil.rm(localList[i].path);
        }
      }
    }
  } 
}
function isRemoteTempWorkspaceFile(path){
  return path.indexOf(REMOTE_WORKSPACE_TEMP_PATH) === 0;
}
function autoRefreshRemoteTempFiles(notMsg, cb){
  var workspacePath = vsUtil.getWorkspacePath();
  if(workspacePath)
  {
    if(remoteRefreshStopFlag) 
    {
      cb();
      return;
    }
    var ftpConfigFromTempDir = getFTPConfigFromRemoteTempPath(workspacePath);
    if(ftpConfigFromTempDir.config && ftpConfigFromTempDir.path)
    {
      createFTP(ftpConfigFromTempDir.config, function(ftp){
        //stopWatch();
        downloadRemoteWorkspace(ftp, ftpConfigFromTempDir.config, ftpConfigFromTempDir.path, function(){
          if(!notMsg)vsUtil.msg("Remote Info downloading success.");
          if(cb)cb();
        }, notMsg, notMsg === false ? 1 : undefined);
      });
    }
  }
}
function removeRefreshRemoteTimer(){
  clearTimeout(remoteRefreshFlag);
}
function setRefreshRemoteTimer(isNow){
  removeRefreshRemoteTimer();
  remoteRefreshFlag = setTimeout(function(){
    autoRefreshRemoteTempFiles(isNow ? false : true, function(){
      if(isNow)startWatch();
    });
  }, isNow ? 0 : 1000 * 60 * 3);
}
function backup(ftp, ftpConfig, path, backupName, cb){
  if(typeof backupName === 'function')
  {
    cb = backupName;
    backupName = undefined;
  }
  if(ftpConfig.backup)
  {
    fileUtil.mkdir(ftpConfig.backup, function(err){
      if(err)
      {
        output("Backup folder create fail. Check your backup path : " + err.message);
        cb(err);
      }
      else
      {
        var now = backupName ? backupName : commonUtil.getNow().replace(/[^0-9]/g, '');
        var ymd = now.substring(0, 8);
        if(typeof path === 'string')
        {
          main(path, cb);
        }
        else if(path instanceof Array)
        {
          loop(path, function(i, value, next){
            main(value, function(err){
              next();
            });
          }, function(){
            cb();
          });
        }
        function main(path, cb){
          var parent = pathUtil.getParentPath(path);
          var filename = pathUtil.getFileName(path);
          var backupFolder = pathUtil.join(ftpConfig.backup, ymd, now, parent);
          var savePath = pathUtil.join(backupFolder, filename);
          ftp.exist(path, function(result){
            if(result)
            {
              ftp.download(path, savePath, function(err){
                if(err) output("Backup fail : " + err.message);
                //else output("Backup Success : " + path + " => " + savePath);
                cb(err);
              });
            }
            else cb();
          });
        }
      }
    });
  }
  else 
  { 
    cb();
  }
}
function runAfterCheck(path, cb){
  setTimeout(function(){
    if(path != vsUtil.getActiveFilePath())
    {      
      cb();
    }
  }, 100);
}
function deleteToRemoteTempPath(localFilePath, cb){
  if(isRemoteTempWorkspaceFile(localFilePath))
  {
    var ftpConfig = getFTPConfigFromRemoteTempPath(localFilePath);
    if(ftpConfig.config && ftpConfig.path)
    {
      createFTP(ftpConfig.config, function(ftp){
        backup(ftp, ftpConfig, ftpConfig.path, function(){
          ftp.rm(ftpConfig.path, function(err){
            if(!err)
            {
              fileUtil.rm(localFilePath, function(err){
                output("Deleted : " + ftpConfig.path);
                if(cb)cb();
              });
            }
          });
        });
      });
    }
    return true;
  }
  else
  {
    vsUtil.msg("Context menu 'Delete' is only possible to remote file or directory.");
    if(cb)cb();
  }
  return false;
}
function updateToRemoteTempPath(remoteTempPath, existCheck, cb){
  if(typeof existCheck === 'function')
  {
    cb = existCheck;
    existCheck = undefined;
  }
  remoteTempPath = pathUtil.normalize(remoteTempPath);
  var ftpConfig = getFTPConfigFromRemoteTempPath(remoteTempPath);
  if(ftpConfig.config && ftpConfig.path && ftpConfig.config.autosave === true)
  {
    var isDir = fileUtil.isDirSync(remoteTempPath);
    createFTP(ftpConfig.config, function(ftp){
      if(existCheck)
      {
        ftp.exist(remoteTempPath, function(result){
          if(!result) main();
        });
      }
      else 
      {
        fileUtil.stat(remoteTempPath, function(stats){
          if(!isDir && stats.size == 0)
          {
            vsUtil.warning("Do you want to save(=upload) the empty file? (If the file exists on the server, overwrite it)", "OK").then(function(btn){
              if(btn == "OK") main();
            });
          }
          else main();
        });
      }

      function main(){
        remoteRefreshStopFlag = true;
        setTimeout(function(){
          backup(ftp, ftpConfig.config, ftpConfig.path, function(err){
            ftp.upload(remoteTempPath + (isDir ? "/**" : ""), ftpConfig.path, function(err){
              //console.log("save upload : ", remoteTempPath + (isDir ? "/**" : ""));
              remoteRefreshStopFlag = false;
              if(err) output("upload fail : " + ftpConfig.path + " => " + err);
              if(cb) cb(err);
            });
          });
        }, 10);        
      }      
    });
  }
  else if(CONFIG_PATH_TEMP == remoteTempPath)
  {      
    var val = fs.readFileSync(CONFIG_PATH_TEMP).toString();
    try{
      val = JSON.parse(val);
      writeConfigFile(val);
    }catch(e){
      vsUtil.error("Fail to save. Check Simple-FTP config file syntax.");
    }
  }
}
function startWatch(){
  console.log("startWatch : %s", vsUtil.getWorkspacePath());

  //watch.createMonitor(vsUtil.getWorkspacePath(), {interval:1}, function (monitor) {
    /*
    monitor.on("created", function (path, stats) {
      path = pathUtil.normalize(path);
      console.log("create : ", path, stats);
      if(fileUtil.isDirSync(path))
      {
        fileUtil.ls(path, function(err, list){
          if(!err && list.length == 0)
          {
            updateToRemoteTempPath(path);
          }
          else if(!err)
          {
            for(var o of list)
            {
              if(o.size > 0)
              {
                updateToRemoteTempPath(path, true);
                break;
              }
            }
          }
        }, true);
      }
      else
      {
        if(stats && stats.size)
        {
          updateToRemoteTempPath(path, true, function(err){
            if(!err)fileUtil.writeFile(path, "");
          });
        }
      }
      
      // Handle new files
    });
    */
    // monitor.on("changed", function (path, curr, prev) {
    //   console.log("changed : ", path, curr, prev);
    //   // Handle file changes
    // })
    /*
    monitor.on("removed", function (path, stats) {
      path = pathUtil.normalize(path);
      console.log("remove dir : ", path, stats);
      if(fileUtil.isDirSync(path))
      {
        addJob(function(next){
          deleteToRemoteTempPath(path, function(){next();});
        });
      }
      else
      {
        fileUtil.exist(pathUtil.getParentPath(path), function(result){
          if(result)
          {
            addJob(function(next){
              deleteToRemoteTempPath(path, function(){next();});
            });
          }
        });
      }
      
      // Handle removed files
    });

    */
    //monitor.stop(); // Stop watching
  //});
  



  
  watcher = chokidar.watch(vsUtil.getWorkspacePath(), {ignoreInitial:true, ignorePermissionErrors:true});
  watcher.on('add', (path, stats) => {
    path = pathUtil.normalize(path);
    if(stats && stats.size)
    {
      addJob(function(next){
        updateToRemoteTempPath(path, function(err){
          if(!err)fileUtil.writeFile(path, "");
          next();
        });
      });
    }
  });
  watcher.on('addDir', (path) => {
    path = pathUtil.normalize(path);
    fileUtil.ls(path, function(err, list){
      if(!err && list.length == 0)
      {
        addJob(function(next){
          updateToRemoteTempPath(path, function(){next();});
        });
      }
    });
  });
  /*
  watcher.on('unlink', (path) => {
    path = pathUtil.normalize(path);
    //fileUtil.exist(pathUtil.getParentPath(path), function(result){
    //  if(result) 
    //  {
        addJob(function(next){
          deleteToRemoteTempPath(path, function(){next();});
        });
    //  }
    //});
  });
  */
}
function stopWatch(){
  console.log("stopWatch");
  if(watcher)watcher.close();
  watcher = null;
}
var watchJob = {job:[], flag:false};
function addJob(j){
  watchJob.job.push(j);
  playJob();
}
function playJob(){
  if(watchJob.flag) return;
  watchJob.flag = true;
  var job = null;
  loop.while(function(){
    job = watchJob.job.shift();
    return job ? true : false;
  }, function(next){
    job(next);
  }, function(){
    watchJob.flag = false;
  });
}
function getProjectPathInConfig(){
  var workspacePath = vsUtil.getWorkspacePath();
  var config = getConfig();
  var result = [];
  if(config && config instanceof Array)
  {
    for(var o of config)
    {
      if(!o.project || typeof o.project !== 'object') continue;
      for(var k in o.project)
      {
        var v = o.project[k];
        if(v instanceof Array)
        {
          for(var a of v)
          {
            var p = same(k, a);
            if(p) result.push({config:o, path:p});
          }         
        }
        // else if(typeof v === 'object')
        // {
        //   var p = same(k, v.path);
        //   if(p) result.push({config:o, path:p, ignore:v.ignore});
        // }        
        else
        {
          var p = same(k, v);
          if(p) result.push({config:o, path:p});
        }
      }
    }
  }
  function same(key, val){
    if(/^[A-Z]\:/.test(key))
    {
      key = key.substring(0, 1).toLowerCase() + key.substring(1);
    }
    var arr = [key, pathUtil.normalize(key)];
    if(arr.indexOf(workspacePath) > -1)
    {
      return {local:pathUtil.normalize(key), remote:pathUtil.normalize(val)};
    }
    return null;
  }
  return result.length ? result : null;
}
function isIgnoreFile(ftpConfig, remotePath){
  var result = false;
  if(ftpConfig.ignore && ftpConfig.ignore instanceof Array)
  {
    for(var v of ftpConfig.ignore)
    {
      var ignorePattern = pathUtil.join(ftpConfig.path, v);
      if(minimatch(remotePath, ignorePattern))
      {
        result = true;
        break;
      }
    }
  }
  return result;
}
function addWaitList(path, isDir){
  var relativePath = pathUtil.getRelativePath(vsUtil.getWorkspacePath(), path);  
  var result = true;
  for(var o of waitList)
  {
    if(o.path === path || o.isDir && path.indexOf(o.path + "/") === 0)
    {
      result = false;
      break;
    }
  }
  if(result)
  {
    waitList.push({path:path, label:relativePath, isDir:isDir, description:'If selected, removed from the list'});
    if(isDir)
    {
      for(var i=waitList.length-1; i>=0; i--)
      {
        if(waitList[i].path.indexOf(path + "/") === 0)
        {
          waitList.splice(i, 1);
        }
      }
    }
    waitList.sort(function(a, b){
      return a.path > b.path;
    });
    output("Add Wait path : " + relativePath);
  }
}
function deleteWaitList(path){
  if(path)
  {
    var relativePath = pathUtil.getRelativePath(vsUtil.getWorkspacePath(), path);
    for(var i=0; i<waitList.length; i++)
    {
      var o = waitList[i];
      if(o.path === path)
      {
        waitList.splice(i, 1);
        output("Delete wait path : " + relativePath);
        break;
      }
    }
  }
  else
  {
    waitList.length = 0;
    output("Delete all wait path.");
  }
}
function pickWaitList(cb){
  const SAVE_ALL = {label:"= SAVE ALL =", description:'from waiting list'};
  const DELETE_ALL = {label:"= DELETE ALL =", description:'from waiting list'};
  const SAVE_DELETE = {label:"= SAVE ALL & DELETE ALL =", description:'from waiting list'};
  vsUtil.pick(waitList.concat([SAVE_ALL, DELETE_ALL, SAVE_DELETE]), 'Select the path or action. Total : ' + waitList.length, function(item){
    if(item.path)
    {
      deleteWaitList(item.path);
      pickWaitList(cb);
    }
    else if(item.label === DELETE_ALL.label)
    {
      deleteWaitList();
      if(cb)cb();
    }
    else if(item.label === SAVE_ALL.label || item.label === SAVE_DELETE.label)
    {      
      var newList = waitList;
      if(item.label === SAVE_DELETE.label)
      {
        newList = waitList.concat([]);
        deleteWaitList();
      }
      if(cb)cb(newList);
    }
  });
}