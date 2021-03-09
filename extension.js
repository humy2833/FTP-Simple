'use strict';
var vscode = require('vscode');
var fs = require('fs');
//var fse = require('fs-extra');
var loop = require('easy-loop');
var minimatch = require('minimatch');
//var filesize = require('filesize');
var pathUtil = require('./lib/path-util');
var fileUtil = require('./lib/file-util');
var commonUtil = require('./lib/common-util');
var vsUtil = require('./lib/vs-util');
var cryptoUtil = require('./lib/crypto-util');
var EasyFTP = require('easy-ftp');
var chokidar = require('chokidar');
var outputChannel = null;
//var root = null;
var ftps = {};
var remoteRefreshFlag = false;
var remoteRefreshStopFlag = false;
var watcher = null;
var waitList = [];
const CONFIG_NAME = "ftp-simple.json";
//const CONFIG_FTP_TEMP = "/ftp-simple/remote-temp";
const CONFIG_FTP_WORKSPACE_TEMP = "remote-workspace-temp";
let CONFIG_PATH, CONFIG_PATH_TEMP, WAIT_COPY_PATH, REMOTE_WORKSPACE_TEMP_PATH;
const REMOTE_TEMP_PATHS = {};

function getRemoteWorkSpaceTempPath() {
  return ((function () {
    let p = vsUtil.getConfiguration('ftp-simple.remote-workspace');
    if (!p) return null;
    let stat = fileUtil.statSync(p);
    if (stat) {
      if (stat.type == 'd') return p;
      else return null;
    }
    else {
      try {
        fileUtil.mkdirSync(p);
        return p;
      } catch (e) {
        return null;
      }
    }
  })() || vsUtil.getConfigPath(CONFIG_FTP_WORKSPACE_TEMP));
}
function moveOldConfigFile() {
  let oldConfig = vsUtil.getOldConfigPath(CONFIG_NAME);
  if (!fileUtil.existSync(CONFIG_PATH) && fileUtil.existSync(oldConfig)) {
    fileUtil.copy(oldConfig, CONFIG_PATH, (e) => {
      if (!e) fileUtil.rm(oldConfig);
    });
  }
}

function activate(context) {
  vsUtil.setContext(context);
  var subscriptions = [];
  outputChannel = vsUtil.getOutputChannel("ftp-simple");
  REMOTE_WORKSPACE_TEMP_PATH = getRemoteWorkSpaceTempPath();
  CONFIG_PATH = vsUtil.getConfigPath(CONFIG_NAME);
  CONFIG_PATH_TEMP = vsUtil.getConfigPath("ftp-simple-temp.json");
  // REMOTE_TEMP_PATH = vsUtil.getConfigPath(CONFIG_FTP_TEMP);
  moveOldConfigFile();
  console.log("ftp-simple start : ", CONFIG_PATH);
  console.log("WorkSpacePath :", vsUtil.getWorkspacePath());
  output("REMOTE_WORKSPACE_PATH = " + REMOTE_WORKSPACE_TEMP_PATH);
  // destroy(true);

  setRefreshRemoteTimer(true);
  //startWatch();  

  vscode.workspace.onDidSaveTextDocument(function (event) {
    // console.log("onDidSaveTextDocument 파일 저장 : ", event, vsUtil.getActiveFilePathAll(), event.fileName, Date.now());
    updateToRemoteTempPath(event.fileName);
  });
  vscode.workspace.onDidCloseTextDocument(function (event) {
    //console.log("파일 닫기0 : ", event); 
    //파일 닫을때, 파일 형식 바뀔때
    // console.log("onDidCloseTextDocument 파일 닫을때 : ", event, vsUtil.getActiveFilePathAll(), event.fileName, Date.now());
    var remoteTempPath = pathUtil.normalize(event.fileName);
    if (!vsUtil.isChangeTextDocument(remoteTempPath)) return;
    var ftpConfig = getFTPConfigFromRemoteTempPath(remoteTempPath);

    if (isRemoteTempWorkspaceFile(remoteTempPath)) {
      var stat = fileUtil.statSync(remoteTempPath);
      if (stat && stat.size > 0) {
        runAfterCheck(remoteTempPath, function () {
          if (REMOTE_TEMP_PATHS[remoteTempPath] === undefined) {
            fileUtil.writeFile(remoteTempPath, "", function () { });
          }
          else {
            REMOTE_TEMP_PATHS[remoteTempPath] = function (cb) {
              fileUtil.writeFile(remoteTempPath, "", function () {
                if (cb) cb();
              });
            };
          }
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
    else if (ftpConfig.config && ftpConfig.path) {
      var path = pathUtil.normalize(event.fileName);
      runAfterCheck(path, function () {
        fileUtil.rm(path);
      });
    }
    else if (CONFIG_PATH_TEMP == remoteTempPath || CONFIG_PATH_TEMP + ".git" == remoteTempPath) {
      fileUtil.rm(CONFIG_PATH_TEMP);
    }
  });

  // vscode.workspace.onDidChangeTextDocument(function(event){
  //   //소스 수정할때,파일 닫을때, 파일 형식 바뀔때
  //   //console.log("onDidChangeTextDocument : ", event);
  // });

  vscode.window.onDidChangeActiveTextEditor(function (event) {
    if (!(event && event.document && event.document.fileName)) return;
    var remoteTempPath = pathUtil.normalize(event.document.fileName);//(event.fileName);
    if (!fileUtil.existSync(remoteTempPath)) return;

    var ftpConfigFromTempDir = getFTPConfigFromRemoteTempPath(remoteTempPath);
    var stat = fileUtil.statSync(remoteTempPath);
    if (isRemoteTempWorkspaceFile(remoteTempPath) && stat.size === 0) {
      createFTP(ftpConfigFromTempDir.config, function (ftp) {
        var fileName = pathUtil.getFileName(remoteTempPath);
        if (fileName.indexOf("[DIR] ") === 0) {
          var realRemotePath = pathUtil.join(pathUtil.getParentPath(ftpConfigFromTempDir.path), fileName.replace("[DIR] ", ""));
          downloadRemoteWorkspace(ftp, ftpConfigFromTempDir.config, realRemotePath, function () { }, true, 1);
          fileUtil.rm(remoteTempPath);
        }
        else if (new Date().getTime() - stat.date.getTime() >= 200) {
          ftp.download(ftpConfigFromTempDir.path, remoteTempPath, function () {
            if (watcher) {
              setTimeout(function () {
                downloadRemoteWorkspace(ftp, ftpConfigFromTempDir.config, pathUtil.getParentPath(ftpConfigFromTempDir.path), function () { }, true, 1);
              }, 100);
            }
          });
        }
        else  //new file
        {
          ftp.exist(ftpConfigFromTempDir.path, function (bool) {
            if (bool) {
              vsUtil.confirm("Remote server already exist file '" + ftpConfigFromTempDir.path + "'. Overwrite?", "OK").then(function (btn) {
                if (btn == "OK") {
                  up();
                }
              });
            }
            else {
              up();
            }
          });
          function up() {
            ftp.upload(remoteTempPath, ftpConfigFromTempDir.path, function (err) {
              if (err) output("upload fail : " + ftpConfigFromTempDir.path + " => " + err.message);
            });
          }
        }
      });
    }
    if (ftpConfigFromTempDir.config && ftpConfigFromTempDir.path && ftpConfigFromTempDir.config.autosave === true) {
      vsUtil.status("If save, Auto save to remote server.");
    }
    else {
      vsUtil.status("");
    }
  });
  subscriptions.push(vscode.commands.registerCommand('ftp.reset', function () {
    closeFTP();
  }));
  subscriptions.push(vscode.commands.registerCommand('ftp.config', function () {
    //확장 설정 가져오기(hello.abcd 일때);
    //console.log(JSON.stringify(vscode.workspace.getConfiguration('hello')));
    var configSet = initConfig();
    if (configSet.result) {
      fileUtil.writeFile(CONFIG_PATH_TEMP, JSON.stringify(configSet.json, null, '\t'), function () {
        vsUtil.openTextDocument(CONFIG_PATH_TEMP);
      });
    }
  }));

  subscriptions.push(vscode.commands.registerCommand('ftp.remote.workspace.open', function () {
    getSelectedFTPConfig().then(function (ftpConfig) {
      createFTP(ftpConfig, function (ftp) {
        getSelectedFTPFile(ftp, ftpConfig, ftpConfig.path, "Select the path want to remote open to workspace", [{ label: ".", description: ftpConfig.path }], "D", function selectItem(item, parentPath, filePath) {
          if (isCurrentWorkspace(ftpConfig, parentPath)) {
            vsUtil.msg("Already workspace");
            return;
          }
          fileUtil.rm(getRemoteWorkspace(ftpConfig, parentPath), function () {
            downloadRemoteWorkspace(ftp, ftpConfig, parentPath, function (localPath) {
              vsUtil.openFolder(localPath);
            }, false, 1);
          });
        });
      });
    });
  }));

  subscriptions.push(vscode.commands.registerCommand('ftp.rename', function (item) {
    var localFilePath = vsUtil.getActiveFilePath(item);
    if (localFilePath && isRemoteTempWorkspaceFile(localFilePath)) {
      var parentPath = pathUtil.getParentPath(localFilePath);
      var fileName = pathUtil.getFileName(localFilePath);
      var ftpConfig = getFTPConfigFromRemoteTempPath(localFilePath);
      if (ftpConfig.config && ftpConfig.path) {
        vsUtil.input({
          value: fileName,
          placeHolder: "Please enter a name to change"
        })
          .then(function (name) {
            if (!name) return;
            var newLocalPath = pathUtil.join(pathUtil.getParentPath(localFilePath), name);
            fileUtil.exist(newLocalPath, function (bool) {
              if (bool) output("Rename error : Already exists(client) => " + newLocalPath);
              else {
                createFTP(ftpConfig.config, function (ftp) {
                  var newServerPath = pathUtil.join(pathUtil.getParentPath(ftpConfig.path), name);
                  ftp.exist(newServerPath, function (bool) {
                    if (bool) {
                      output("Rename error : Already exists(server) => " + newServerPath);
                    }
                    else {
                      stopWatch();
                      fs.rename(localFilePath, newLocalPath, function () {
                        ftp.mv(ftpConfig.path, newServerPath, function (err, np) {
                          startWatch();
                          if (err) {
                            output("Rename error : " + err);
                          }
                          else {
                            output("Renamed : " + ftpConfig.path + " => " + np);
                          }
                        });
                      });
                    }
                  });
                });
              }
            });
          });
      }
    }
    else {
      getSelectedFTPConfig(function (ftpConfig) {
        createFTP(ftpConfig, function (ftp) {
          getSelectedFTPFile(ftp, ftpConfig, ftpConfig.path, "Select the file or directory want to rename", ["."], function (serverItem, serverParentPath, serverFilePath) {
            var orgPath = serverFilePath || serverParentPath;
            var parentPath = pathUtil.getParentPath(serverFilePath || serverParentPath);
            var fileName = pathUtil.getFileName(serverFilePath || serverParentPath);
            _process();

            function _process() {
              vsUtil.input({
                value: fileName,
                placeHolder: "Please enter a name to change"
              })
                .then(function (name) {
                  if (!name) return;
                  var newServerPath = pathUtil.join(parentPath, name);
                  ftp.exist(newServerPath, function (bool) {
                    if (bool) {
                      output("Rename error : Already exists(server) => " + newServerPath);
                      _process();
                    }
                    else {
                      ftp.mv(orgPath, newServerPath, function (err, np) {
                        if (err) {
                          output("Rename error : " + err);
                        }
                        else {
                          output("Renamed : " + orgPath + " => " + np);
                        }
                      });
                    }
                  });
                });
            }
          });
        });
      });
    }
  }));

  subscriptions.push(vscode.commands.registerCommand('ftp.download', function (item) {
    var workspacePath = vsUtil.getWorkspacePath();
    if (!workspacePath) {
      vsUtil.msg("Please, open the workspace directory first.");
      return;
    }
    var isMore = true;
    var localFilePath = vsUtil.getActiveFilePath(item);
    var baseProjects = getProjectPathInConfig();
    var ftpConfig = getFTPConfigFromRemoteTempPath(localFilePath);

    //remote 가 아니고 설정된 프로젝트의 워크스페이스라면
    if (!ftpConfig.config && baseProjects) {
      getSelectedProjectFTPConfig(baseProjects, 'DOWNLOAD', function (item) {
        if (typeof item === 'object') {
          isMore = false;
          createFTP(item, function (ftp) {
            fileUtil.isDir(localFilePath, function (err, isDir) {
              var remotePath = pathUtil.join(item.remote, pathUtil.getRelativePath(workspacePath, localFilePath));
              download(ftp, item, remotePath, localFilePath, isDir, !isDir);
            });
          });
        }
        else {
          getSelectedFTPConfig(downMain);
        }
      });
    }
    else {
      getSelectedFTPConfig(downMain);
    }

    function downMain(ftpConfig) {
      createFTP(ftpConfig, function (ftp) {
        selectFirst(ftp, ftpConfig.path);
      });
    }
    function selectFirst(ftp, path) {
      getSelectedFTPFile(ftp, ftpConfig, path, "Select the file or directory want to download", [".", "*"], function (serverItem, serverParentPath, serverFilePath) {
        getSelectedLocalPath(workspacePath, workspacePath, "Select the path want to download", ".", "D", selectItem);
        function selectItem(item, parentPath, filePath) {
          var isAll = serverItem.label === "*";
          var isDir = serverFilePath ? false : true;
          var localPath = isDir ? (isAll ? parentPath : pathUtil.join(parentPath, pathUtil.getFileName(serverParentPath))) : pathUtil.join(parentPath, serverItem.label);
          var remotePath = isDir ? serverParentPath + "/**" : serverFilePath;
          if (isAll || fileUtil.existSync(localPath)) {
            confirmExist(ftp, isDir, parentPath, remotePath, localPath, isAll);
          }
          else {
            download(ftp, ftpConfig, remotePath, localPath, false, serverFilePath);
          }
        }
        function confirmExist(ftp, isDir, path, remotePath, localPath, isAll) {
          var title = "Already exist " + (isDir ? "directory" : "file") + " '" + localPath + "'. Overwrite?";
          if (isAll) title = "If the file exists it is overwritten by force. Continue?";
          vsUtil.warning(title, "Back", "OK").then(function (btn) {
            if (btn == "OK") download(ftp, ftpConfig, remotePath, localPath, isAll, serverFilePath);
            else if (btn == "Back") getSelectedLocalPath(path, workspacePath, "Select the path want to download", ".", "D", selectItem);
          });
        }
      });
    }
    function download(ftp, ftpConfig, remotePath, localPath, isAll, serverFilePath) {
      ftp.download(remotePath, localPath, function (err) {
        if (err) {
          for (let o of err) {
            output("download fail : " + o.remote + " => " + o.message);
          }
        }
        else {
          if (!serverFilePath)
            output(ftpConfig.name + " - Directory downloaded : " + localPath + (isAll ? "/*" : ""));
          if (isMore) selectFirst(ftp, pathUtil.getParentPath(remotePath));
        }
      })
    }
  }));

  subscriptions.push(vscode.commands.registerCommand('ftp.diff', function (item) {
    var localFilePath = vsUtil.getActiveFilePathAndMsg(item, "Please select a file to compare");
    if (!localFilePath) return;
    if (fileUtil.isDirSync(localFilePath)) {
      vsUtil.msg("Select a file. The directory is impossible.");
      return;
    }
    var baseProjects = getProjectPathInConfig();
    if (baseProjects) {
      getSelectedProjectFTPConfig(baseProjects, 'DIFF', function (item) {
        if (item === 'SERVER ALL') {
          getSelectedFTPConfig(diff);
        }
        else if (typeof item === 'object') {
          var workspacePath = vsUtil.getWorkspacePath();
          createFTP(item, function (ftp) {
            var remotePath = pathUtil.join(item.remote, pathUtil.getRelativePath(workspacePath, localFilePath));
            ftp.exist(remotePath, function (result) {
              if (result) {
                downloadAndDiff(ftp, item, remotePath);
              }
              else vsUtil.error("The file does not exist on the server.");
            });
          });
        }
      });
    }
    else {
      getSelectedFTPConfig(diff);
    }


    function diff(ftpConfig) {
      createFTP(ftpConfig, function (ftp) {
        getSelectedFTPFile(ftp, ftpConfig, ftpConfig.path, "Select the file want to compare", function selectItem(item, parentPath, filePath) {
          downloadAndDiff(ftp, ftpConfig, filePath);
        });
      });
    }
    function downloadAndDiff(ftp, ftpConfig, filePath) {
      download(ftp, ftpConfig, filePath, function (err, path) {
        if (!err) {
          vsUtil.diff(localFilePath, path);
        }
      });
    }
  }));

  subscriptions.push(vscode.commands.registerCommand('ftp.delete', function (item) {
    if (item) {
      var localFilePath = vsUtil.getActiveFilePath(item);
      if (deleteToRemoteTempPath(localFilePath)) return;
    }
    else if (item === null)  //워크스페이스 선택
    {

    }
    getSelectedFTPConfig(function (ftpConfig) {
      createFTP(ftpConfig, function (ftp) {
        selectFirst(ftp, ftpConfig.path);
      });
      function selectFirst(ftp, path) {
        getSelectedFTPFile(ftp, ftpConfig, path, "Select the file or path want to delete", [{ label: ".", description: ftpConfig.path }], function selectItem(item, parentPath, filePath) {
          var deletePath = filePath ? filePath : parentPath;
          vsUtil.warning("Are you sure you want to delete '" + deletePath + "'?", "Back", "OK")
            .then(function (btn) {
              if (btn == "OK") {
                ftp.rm(deletePath, function (err) {
                  if (err) vsUtil.error(err.toString());
                  else {
                    output("Deleted : " + deletePath);
                    selectFirst(ftp, filePath ? parentPath : pathUtil.getParentPath(parentPath));
                  }
                });
              }
              else if (btn == "Back") getSelectedFTPFile(ftp, ftpConfig, parentPath, "Select the file or path want to delete", [{ label: ".", description: parentPath }], selectItem);
            });
        });
      }
    });
  }));

  subscriptions.push(vscode.commands.registerCommand('ftp.mkdir', function () {
    getSelectedFTPConfig(function (ftpConfig) {
      createFTP(ftpConfig, function (ftp) {
        selectFirst(ftp, ftpConfig.path);
      });
      function selectFirst(ftp, path) {
        getSelectedFTPFile(ftp, ftpConfig, path, "Select the path want to create directory", [{ label: ".", description: ftpConfig.path }], "D", function selectItem(item, parentPath, filePath) {
          createRemoteDirecotry(ftp, parentPath, "", function () {
            selectFirst(ftp, parentPath);
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
    getSelectedFTPConfig(function (ftpConfig) {
      createFTP(ftpConfig, function (ftp) {
        selectFirst(ftp, ftpConfig.path);
      });
      var column = 1;
      function selectFirst(ftp, path) {
        getSelectedFTPFile(ftp, ftpConfig, path, "Select the file want to open", function (item, parentPath, filePath) {
          downloadOpen(ftp, ftpConfig, filePath, function (err) {
            if (!err && column <= 3) selectFirst(ftp, parentPath);
          }, column++);
        });
      }
    });
  }));

  subscriptions.push(vscode.commands.registerCommand('ftp.save', function (item) {
    //console.log("item:",item);
    //if(vscode.window.activeTextEditor)console.log("activeTextEditor:",vscode.window.activeTextEditor.document.uri.fsPath);
    //else console.log("vscode.window.activeTextEditor nothing");
    var isForceUpload = true;//item && item.fsPath ? true : false;
    var localFilePath = vsUtil.getActiveFilePathAndMsg(item, "Please select a file to upload");
    //console.log("localFilePath:",localFilePath);
    var workspacePath = vsUtil.getWorkspacePath();
    // if(item === null && workspacePath) 
    // {
    //   localFilePath = workspacePath;
    //   isForceUpload = true;
    // }
    if (!localFilePath) return;

    var baseProjects = getProjectPathInConfig();
    var isDir = fileUtil.isDirSync(localFilePath);
    var isIncludeDir = true;
    checkAndRunAutoUpload().then(flag => {
      if (flag) getSelectProject();
    });

    function checkAndRunAutoUpload() {
      if (!baseProjects) return Promise.resolve(1);
      let count = 0;
      let task = [];
      //let orgForce = isForceUpload;
      for (let o of baseProjects) {
        if (o.autosave) {
          task.push(function (next) {
            createFTP(o.config, function (ftp) {
              upload(ftp, o.config, localFilePath, pathUtil.join(o.path.remote, pathUtil.getRelativePath(workspacePath, localFilePath)), function (err) {
                count++;
                next();
              });
            });
          });
        }
      }
      if (task.length) {
        return new Promise(ok => {
          loop.series(task, function (err) {
            ok(count == baseProjects.length ? 0 : 1);
          });
        });
      }
      else return Promise.resolve(1);
    }
    function getSelectProject() {
      if (baseProjects) {
        getSelectedProjectFTPConfig(baseProjects, 'SAVE', function (item) {
          if (typeof item === 'object') {
            isForceUpload = true;
            createFTP(item, function (ftp) {
              upload(ftp, item, localFilePath, pathUtil.join(item.remote, pathUtil.getRelativePath(workspacePath, localFilePath)));
            });
          }
          else if (item === 'SERVER ALL') {
            getSelectedFTPConfig(saveMain);
          }
          else if (item === 'SAVE ALL') {
            isForceUpload = true;
            var backupName = commonUtil.getNow().replace(/[^0-9]/g, '');
            loop(baseProjects, function (i, value, next) {
              createFTP(value.config, function (ftp) {
                var remotePath = pathUtil.join(value.path.remote, pathUtil.getRelativePath(workspacePath, localFilePath));
                if (value.config.backup) {
                  getBackupList(localFilePath, remotePath, function (backupList, realLocalPath) {
                    backup(ftp, value.config, backupList, backupName, function (err) {
                      var tempBackup = value.config.backup;
                      delete value.config.backup;
                      upload(ftp, value.config, localFilePath, remotePath, backupName, function () {
                        value.config.backup = tempBackup;
                        next();
                      });
                    });
                  });
                }
                else {
                  upload(ftp, value.config, localFilePath, remotePath, backupName, next);
                }
              });
            });
          }
          else if (item.indexOf('WAIT') === 0) {
            if (item.indexOf('ALL') === -1) {
              addWaitList(localFilePath, isDir);
            }
            else {
              pickWaitList(function (list) {
                if (list && list.length) {
                  getSelectedProjectFTPConfig(baseProjects, 'SAVE_WAIT_LIST', function (item) {
                    var backupName = commonUtil.getNow().replace(/[^0-9]/g, '');
                    if (typeof item === 'object') {
                      createFTP(item, function (ftp) {
                        if (item.backup) {
                          loop(list, function (i, value, next) {
                            getBackupList(value.path, pathUtil.join(item.remote, value.label), function (backupList, realLocalPath) {
                              backup(ftp, item, backupList, backupName, function (err) {
                                next();
                              });
                            });
                          }, function (err) {
                            delete item.backup;
                            loop(list, function (i, value, next) {
                              upload(ftp, item, value.path, pathUtil.join(item.remote, value.label), backupName, next);
                            });
                          });
                        }
                        else {
                          loop(list, function (i, value, next) {
                            upload(ftp, item, value.path, pathUtil.join(item.remote, value.label), backupName, next);
                          });
                        }
                      });
                    }
                    else if (item === 'SAVE ALL') {
                      loop(baseProjects, function (i, value, next) {
                        createFTP(value.config, function (ftp) {
                          if (value.config.backup) {
                            loop(list, function (j, v, next) {
                              getBackupList(v.path, pathUtil.join(value.path.remote, v.label), function (backupList, realLocalPath) {
                                backup(ftp, value.config, backupList, backupName, function (err) {
                                  next();
                                });
                              });
                            }, function (err) {
                              var tempBackup = value.config.backup;
                              delete value.config.backup;
                              loop(list, function (j, v, next) {
                                upload(ftp, value.config, v.path, pathUtil.join(value.path.remote, v.label), backupName, next);
                              }, function (err) {
                                value.config.backup = tempBackup;
                                next();
                              });
                            });
                          }
                          else {
                            loop(list, function (j, v, next) {
                              upload(ftp, value.config, v.path, pathUtil.join(value.path.remote, v.label), backupName, next);
                            }, function (err) {
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
      else {
        if (isDir) {
          var fileName = pathUtil.getFileName(localFilePath);
          selectUploadType(fileName, function (includeDir) {
            isIncludeDir = includeDir;
            getSelectedFTPConfig(saveMain);
          });
        }
        else {
          getSelectedFTPConfig(saveMain);
        }
      }
    }
    function saveMain(ftpConfig) {
      createFTP(ftpConfig, function (ftp) {
        getSelectedFTPFile(ftp, ftpConfig, ftpConfig.path, "Select the path" + (isDir ? "" : " or file") + " want to save", [{ label: ".", description: ftpConfig.path }, "= CREATE DIRECTORY ="], (isDir ? "D" : null), function (item, path, filePath) {
          selectItem(ftp, item, path, filePath);
        });
      });

      function selectItem(ftp, item, path, filePath) {
        if (filePath) {
          if (ftpConfig.confirm === false) {
            upload(ftp, ftpConfig, localFilePath, path, function (err) {
              if (!err) {
                hideAndOpen(ftp, ftpConfig, path);
              }
            });
          }
          else confirmExist(ftp, ftpConfig, path, localFilePath, filePath);
        }
        else if (isIncludeDir) {
          var fileName = pathUtil.getFileName(localFilePath);
          var isInput = false;
          //existProc(fileName);
          vsUtil.input({
            value: fileName
            , placeHolder: "Write the " + (isDir ? "directory" : "file") + " name"
            , prompt: "Write the " + (isDir ? "directory" : "file") + " name"
            , validateInput: function (value) {
              isInput = /[\\\/|*?<>:"]/.test(value) ? true : null;
              //console.log("validateInput:"+value+"$",isInput);
              return isInput;
            }
          }).then(function (name) {
            //console.log("then:"+name+"$", isInput);
            if (name) existProc(name);
            else {
              if (isInput) vsUtil.error("Filename to include inappropriate words.");
            }
          });

          function existProc(fileName) {
            var rPath = pathUtil.join(path, fileName);
            if (ftpConfig.confirm === false) {
              upload(ftp, ftpConfig, localFilePath, rPath, function (err) {
                if (!err) {
                  hideAndOpen(ftp, ftpConfig, rPath);
                }
              });
            }
            else {
              exist(ftp, path, fileName, function (result) {
                if (result) confirmExist(ftp, ftpConfig, path, localFilePath, rPath);
                else {
                  upload(ftp, ftpConfig, localFilePath, rPath, function (err) {
                    if (!err) {
                      hideAndOpen(ftp, ftpConfig, rPath);
                    }
                  });
                }
              });
            }
          }
        }
        else {
          upload(ftp, ftpConfig, localFilePath, path, function (err) {
            if (!err) {
              hideAndOpen(ftp, ftpConfig, path);
            }
          });
        }
      }
    }
    function hideAndOpen(ftp, ftpConfig, remotePath) {
      if (!isForceUpload) {
        vsUtil.hide();
        downloadOpen(ftp, ftpConfig, remotePath);
      }
    }
    function confirmExist(ftp, ftpConfig, path, localPath, remotePath) {
      vsUtil.warning("Already exist " + (isDir ? "directory" : "file") + " '" + remotePath + "'. Overwrite?", "Back", "OK").then(function (btn) {
        if (btn == "OK") upload(ftp, ftpConfig, localPath, remotePath);
        else if (btn == "Back") getSelectedFTPFile(ftp, ftpConfig, path, "Select the path" + (isDir ? "" : " or file") + " want to save", [{ label: ".", description: path }], selectItem);
      });
    }
  }));

  for (var i = 0; i < subscriptions.length; i++) context.subscriptions.push(subscriptions[i]);
}
exports.activate = activate;

// this method is called when your extension is deactivated
function deactivate() {
  fileUtil.rm(CONFIG_PATH_TEMP);
  closeFTP();
  destroy();
}
exports.deactivate = deactivate;

function destroy(isStart) {
  // var ws = vsUtil.getWorkspacePath();
  // if(isStart && ws && vsUtil.getWorkspacePath().indexOf(REMOTE_WORKSPACE_TEMP_PATH) === -1)
  // {
  //   fse.remove(REMOTE_WORKSPACE_TEMP_PATH, function(){});
  // }
}
function getPassphrase(ftpConfig, cb) {
  fs.readFile(ftpConfig.privateKey, 'utf8', function (err, data) {
    if (err) {
      output("Cannot read the private key: " + ftpConfig.prirvateKey);
    }
    else {
      if (data.includes('ENCRYPTED') || (data.includes('PuTTY') && !data.includes('Encryption: none'))) {
        vsUtil.input({ password: true, placeHolder: 'Enter the passphrase' }).then(function (item) {
          if (item) {
            ftpConfig.passphrase = item;
            if (cb) cb();
          }
          else closeFTP(ftpConfig.host);
        });
      }
      else if (cb) {
        cb();
      }
    }
  });
}
function getPassword(ftpConfig, cb) {
  if (!ftpConfig.password && !ftpConfig.privateKey) {
    vsUtil.input({ password: true, placeHolder: 'Enter the FTP connect password' }).then(function (item) {
      if (item) {
        ftpConfig.password = item;
        if (cb) cb();
      }
      else closeFTP(ftpConfig.host);
    });
  }
  else if (ftpConfig.privateKey && !ftpConfig.passphrase) {
    getPassphrase(ftpConfig, cb);
  }
  else if (cb) {
    cb();
  }
}
function createFTP(ftpConfig, cb, failCount) {
  getFTP(ftpConfig.host, function (ftp, isConnected, alreadyConnect) {
    if (isConnected) {
      if (cb) cb(ftp);
    }
    else {
      getPassword(ftpConfig, function () {
        var TRY = 5;
        var count = failCount || 0;
        //var ftp = new EasyFTP();
        output(ftpConfig.name + " - " + "FTP Connecting...");
        try { ftp.connect(ftpConfig, ftpConfig.parallel ? ftpConfig.parallel : 1); } catch (e) { console.log("catch : ", e); }
        ftp.on("open", function () {
          count = TRY;
          output(ftpConfig.name + " - " + "FTP open!!");
          if (alreadyConnect) vsUtil.msg(ftpConfig.name + " - FTP reopen!!");
          //addFTP(ftpConfig.host, ftp);
          if (cb) cb(ftp);
        });
        ftp.on("close", function () {
          output(ftpConfig.name + " - " + "FTP close!!");
          deleteFTP(ftpConfig.host);
        });
        ftp.on("error", function (err) {
          output(ftpConfig.name + " - " + err.message);
          var sErr = String(err);
          if (sErr.indexOf("Timed out while waiting for handshake") > -1
            || sErr.indexOf("530 Please login with USER and PASS") > -1
            || sErr.indexOf("All configured authentication methods failed") > -1) TRY = 0;
          //console.log("error 발생", count, TRY, String(err));
          if (count < TRY) {
            count++;
            setTimeout(function () {
              output(ftpConfig.name + " - " + "FTP Connecting try...");
              createFTP(ftpConfig, cb, count);//ftp.connect(ftpConfig);
            }, 500);
          }
          else if (count == TRY) {
            var s = String(err);
            //if(/^Error\: \d+ /.test(s)) s = s.replace(/^Error\: \d+ /, '');
            vsUtil.error(ftpConfig.name + " - Connect fail : " + s);
            closeFTP(ftpConfig.host);
          }
        });
        ftp.on("upload", function (path) {
          output(ftpConfig.name + " - " + "Uploaded : " + path);
        });
        ftp.on("download", function (path) {
          output(ftpConfig.name + " - " + "Downloaded : " + path);
        });
      });
    }
  });


  // function addFTP(host, ftp){
  //   var result = true;
  //   var key = commonUtil.md5(host);
  //   ftps[key] = ftp;
  // }
  function deleteFTP(host) {
    var key = commonUtil.md5(host);
    if (ftps[key]) {
      delete ftps[key];
    }
  }
  function getFTP(host, cb) {
    var key = commonUtil.md5(host);
    var isConnected = false;
    var alreadyConnect = false;
    if (ftps[key]) {
      alreadyConnect = true;
      let isRunTimeout = false;
      let flagTimeout = setTimeout(() => {
        isRunTimeout = true;
        closeFTP(host);
        setTimeout(() => newInstance(), 500);
      }, 5000);
      ftps[key].pwd(function (err, path) {
        clearTimeout(flagTimeout);
        if (!isRunTimeout) {
          if (err) {
            if (ftps[key]) try { ftps[key].close(); } catch (e) { }
            ftps[key] = new EasyFTP();
          }
          else isConnected = true;
          if (cb) setImmediate(cb, ftps[key], isConnected, alreadyConnect);
        }
      });
    }
    else {
      newInstance();
    }
    function newInstance() {
      ftps[key] = new EasyFTP();
      if (cb) setImmediate(cb, ftps[key], isConnected, alreadyConnect);
    }
  }
}
function closeFTP(host) {
  if (host) {
    var key = commonUtil.md5(host);
    try { ftps[key].close(); } catch (e) { }
    try { delete ftps[key]; } catch (e) { }
  }
  else {
    var flag = false;
    for (var i in ftps) {
      flag = true;
      try { ftps[i].close(); } catch (e) { }
      delete ftps[i];
    }
    if (flag) output('Close all FTP connections.');
    else output('Nothing FTP connections.');
  }
}
function setDefaultConfig(config) {
  for (var i = 0; i < config.length; i++) {
    if (config[i].autosave === undefined) config[i].autosave = true;
    if (config[i].confirm === undefined) config[i].confirm = true;
    if (config[i].path === undefined) config[i].path = "/";
  }
  return config;
}
function writeConfigFile(json) {
  fileUtil.writeFileSync(CONFIG_PATH, cryptoUtil.encrypt(JSON.stringify(json, null, '\t')));
  fileUtil.rm(CONFIG_PATH_TEMP);
}
function initConfig() {
  var result = true;
  var json = vsUtil.getConfig(CONFIG_NAME);
  try {
    json = cryptoUtil.decrypt(json);
    json = JSON.parse(json);
  } catch (e) {
    //암호화 안된 파일일때
    try {
      json = JSON.parse(json);
      writeConfigFile(json);
    } catch (ee) {
      if (json === undefined) {
        //설정 없을때
        json = [{ name: "localhost", host: "", port: 21, type: "ftp", username: "", password: "", path: "/" }];
        writeConfigFile(json);
      } else {
        vsUtil.error("Check Simple-FTP config file syntax.");
        fileUtil.writeFile(CONFIG_PATH_TEMP, json, function () {
          vsUtil.openTextDocument(CONFIG_PATH_TEMP);
        });
        result = false;
      }
    }
  }
  json = setDefaultConfig(json);
  return { result: result, json: json };
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
function getConfig() {
  var json = {};
  var config = initConfig();
  if (config.result) {
    json = config.json;
  }
  return json;
}
function getFTPNames(config) {
  var names = [];
  for (var i in config) {
    names.push(config[i].name || config[i].host || "undefined");
  }
  return names;
}
function getFTPConnectInfo(config, name) {
  for (var i in config) {
    if (config[i]["name"] == name || makeTempName(config[i]) == name) {
      return config[i];
    }
  }
  return null;
}
function output(str) {
  vsUtil.output(outputChannel, str);
}
function getFTPConfig(ftpsConfig, name) {
  var ftpConfig = getFTPConnectInfo(ftpsConfig, name);
  if (ftpConfig) {
    if (!ftpConfig.path) ftpConfig.path = "/";
    else ftpConfig.path = pathUtil.normalize(ftpConfig.path);
  }
  return ftpConfig;
}
function getSelectedProjectFTPConfig(projects, type, cb) {
  const ALL = '= SHOW ALL SERVER LIST =';
  const SAVE_ALL = '= SAVE ALL PROJECT =';
  const WAIT = '= WAIT =';
  const WAIT_ALL = '= SHOW ALL WAIT LIST =';
  var list = [];
  for (let i = 0; i < projects.length; i++) {
    list.push({ label: projects[i].config.name, description: projects[i].path.remote, idx: i });
  }
  if (type === 'SAVE_WAIT_LIST') {
    list.push({ label: SAVE_ALL, description: 'Unconditionally overwrite' });
  }
  else {
    if (type === 'SAVE') {
      list.push({ label: WAIT, description: 'Save the file path to the waiting list' });
      if (waitList.length) {
        list.push({ label: WAIT_ALL, description: 'Shows all waiting list' });
      }
      list.push({ label: SAVE_ALL, description: 'Unconditionally overwrite' });
    }
    list.push({ label: ALL });
  }

  vsUtil.pick(list, 'Select the project to ' + type.toLowerCase()).then(function (item) {
    if (item) {
      if (item.label == SAVE_ALL) {
        if (cb) cb('SAVE ALL');
      }
      else if (item.label == WAIT) {
        if (cb) cb('WAIT');
      }
      else if (item.label == WAIT_ALL) {
        if (cb) cb('WAIT ALL');
      }
      else if (item.idx != undefined) {
        var o = projects[item.idx].config;
        o.remote = item.description;
        if (cb) cb(o);
      }
      else if (item.label == ALL) {
        if (cb) cb('SERVER ALL');
      }
    }
  });
}
function getSelectedFTPConfig(cb) {
  return new Promise(function (resolve, reject) {
    var ftpsConfig = getConfig();
    var ftps = getFTPNames(ftpsConfig);
    if (ftps.length == 0) {
      vsUtil.error('Check Simple-FTP config file syntax.');
      return;
    }
    vsUtil.pick(ftps, "Select FTP server", function (name) {
      if (cb) cb(getFTPConfig(ftpsConfig, name));
      else resolve(getFTPConfig(ftpsConfig, name));
    });
  });
}
function getSelectedLocalPath(path, rootPath, placeHolder, addItems, filter, cb) {
  vsUtil.getFileItemForPick(path, filter, function (items) {
    var arr = vsUtil.addItemForFile(items, addItems, path, rootPath);
    vsUtil.pick(arr, placeHolder + ".  Now path '" + path + "'").then(function (item) {
      if (item) {
        if (item.label == "..") {
          getSelectedLocalPath(pathUtil.getParentPath(path), rootPath, placeHolder, addItems, filter, cb);
        } else if (item.type === "D") {
          getSelectedLocalPath(pathUtil.join(path, item.label), rootPath, placeHolder, addItems, filter, cb);
        } else {
          if (cb) cb(item, path, item.type ? pathUtil.join(path, item.label) : null);
        }
      }
    });
  });
}
function getSelectedFTPFile(ftp, ftpConfig, path, placeHolder, addItems, filter, cb) {
  if (typeof addItems === 'function') {
    cb = addItems;
    addItems = undefined;
  }
  if (typeof filter === 'function') {
    cb = filter;
    filter = undefined;
  }
  path = pathUtil.normalize(path);
  ftp.ls(path, function (err, list) {
    if (!err) output("cd " + path);
    else {
      vsUtil.error("Failed to get server file list : " + err.toString());
      return;
    }
    var arr = vsUtil.makePickItemForFile(list, filter);
    arr = vsUtil.addItemForFile(arr, addItems, path, ftpConfig.path);
    vsUtil.pick(arr, placeHolder + ".  Now path '" + path + "'").then(function (item) {
      if (item) {
        if (item.label == "..") {
          getSelectedFTPFile(ftp, ftpConfig, pathUtil.getParentPath(path), placeHolder, addItems, filter, cb);
        } else if (item.type === "D") {
          getSelectedFTPFile(ftp, ftpConfig, pathUtil.join(path, item.label), placeHolder, addItems, filter, cb);
        } else if (item.label === "= CREATE DIRECTORY =") {
          createRemoteDirecotry(ftp, path, "", function () {
            getSelectedFTPFile(ftp, ftpConfig, path, placeHolder, addItems, filter, cb);
          });
        } else {
          if (cb) cb(item, path, item.type ? pathUtil.join(path, item.label) : null);
        }
      }
    });
  });
}
function createRemoteDirecotry(ftp, path, value, cb) {
  var isInput = false;
  vsUtil.input({
    value: value ? value : ""
    , placeHolder: "Enter the name of the directory to be created"
    , prompt: "Now path : " + path
    , validateInput: function (value) {
      return isInput = /[\\|*?<>:"]/.test(value) ? true : null;
    }
  }).then(function (name) {
    if (name) {
      var parent = path;
      var realName = name;
      if (name.indexOf("/") > 0) {
        parent = pathUtil.join(path, pathUtil.getParentPath(name));
        realName = pathUtil.getFileName(name);
      }
      exist(ftp, parent, realName, function (result) {
        if (result) {
          vsUtil.error("Already exist directory '" + name + "'", "Rename")
            .then(function (btn) {
              if (btn) createRemoteDirecotry(ftp, path, name, cb);
            });
        }
        else {
          var p = pathUtil.join(path, name);
          ftp.mkdir(p, function (err) {
            if (!err) {
              output("Create directory : " + p);
              cb();
            }
          });
        }
      });
    }
    else {
      if (isInput) {
        vsUtil.error("Filename to include inappropriate words.");
        cb();
      }
    }
  });
}
function getFTPConfigFromRemoteTempPath(remoteTempPath) {
  var ftpConfig, remotePath;
  var tempPath;
  /*
  if(remoteTempPath.indexOf(REMOTE_TEMP_PATH) === 0)
  {
    tempPath = REMOTE_TEMP_PATH;
  }
  else */if (remoteTempPath.indexOf(REMOTE_WORKSPACE_TEMP_PATH) === 0) {
    tempPath = REMOTE_WORKSPACE_TEMP_PATH;
  }
  if (tempPath) {
    var tempDirName = remoteTempPath.substring(tempPath.length + 1);
    remotePath = tempDirName.substring(tempDirName.indexOf("/"));
    tempDirName = tempDirName.substring(0, tempDirName.indexOf("/"));
    if (!tempDirName) {
      tempDirName = remotePath;
      remotePath = "/";
    }
    ftpConfig = getFTPConfig(getConfig(), tempDirName);
  }
  return { config: ftpConfig, path: remotePath };
}
function getBackupList(localPath, remotePath, cb) {
  fileUtil.isDir(localPath, function (err, isDir) {
    if (isDir) {
      output("Check backup files...");
      var wsLen = vsUtil.getWorkspacePath().length;
      var folder = localPath.substring(wsLen);
      wsLen += folder.length;
      fileUtil.ls(localPath, function (err, list) {
        list.forEach(function (v, i, arr) {
          arr[i] = pathUtil.join(remotePath, v.path.substring(wsLen));
        });
        cb(list, localPath + "/**");
      }, true);
    }
    else {
      cb([remotePath], localPath);
    }
  });
}
function upload(ftp, ftpConfig, localPath, remotePath, backupName, cb) {
  if (typeof backupName === 'function') {
    cb = backupName;
    backupName = undefined;
  }
  if (ftpConfig.backup) {
    getBackupList(localPath, remotePath, function (backupList, realLocalPath) {
      var isDir = localPath != realLocalPath;
      backup(ftp, ftpConfig, backupList, backupName, function (err) {
        localPath = realLocalPath;
        main(isDir);
      });
    });
  }
  else {
    fileUtil.isDir(localPath, function (err, isDir) {
      if (isDir) localPath = localPath + "/**";
      main(isDir);
    });
  }
  function main(isDir) {
    ftp.upload(localPath, remotePath, function (err) {
      // if(!err && !isForceUpload)
      // {
      //   vsUtil.hide();
      //   downloadOpen(ftp, ftpConfig, remotePath);
      // }
      if (!err && isDir) output(ftpConfig.name + " - Directory uploaded : " + remotePath);
      if (err) output("upload fail : [ " + localPath + " => " + remotePath + " ] " + err.message);
      if (cb) cb(err);
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
function download(ftp, ftpConfig, remotePath, cb) {
  var localPath = pathUtil.join(REMOTE_WORKSPACE_TEMP_PATH, makeTempName(ftpConfig), remotePath);
  ftp.download(remotePath, localPath, function (err) {
    if (err) {
      for (let o of err) {
        output("download fail : " + o.remote + " => " + o.message);
      }
    }
    if (cb) cb(err, localPath);
  });
}
function downloadOpen(ftp, ftpConfig, remotePath, cb, column) {
  download(ftp, ftpConfig, remotePath, function (err, localPath) {
    if (!err) {
      fs.stat(localPath, function (err) {
        if (!err) {
          vsUtil.open(localPath, column, function () {
            if (cb) cb();
          });
        }
        else if (cb) cb(err);
      });
    }
    else if (cb) cb(err);
  });
}
function exist(ftp, path, name, cb) {
  ftp.ls(path, function (err, list) {
    var same = false;
    if (err) list = [];
    for (var i in list) {
      if (list[i].name == name) {
        same = true;
        break;
      }
    }
    if (cb) cb(same);
  });
}
function selectUploadType(dirName, cb) {
  vsUtil.pick([{ label: dirName, description: "Including the selected directory", type: 'd' }, { label: dirName + "/**", description: "Exclude the selected directory. If exist file, force overwrite.", type: 'f' }], "Choose the uploaded type", function (item) {
    cb(item.type === 'd');
  });
}
function makeTempName(ftpConfig) {
  return commonUtil.md5(ftpConfig.host + ftpConfig.name + ftpConfig.path);
}
function getRemoteWorkspace(ftpConfig, remotePath) {
  return pathUtil.join(REMOTE_WORKSPACE_TEMP_PATH, makeTempName(ftpConfig), remotePath);
}
function isCurrentWorkspace(ftpConfig, remotePath) {
  var localPath = getRemoteWorkspace(ftpConfig, remotePath);
  return localPath == vsUtil.getWorkspacePath();
}
function downloadRemoteWorkspace(ftp, ftpConfig, remotePath, cb, notMsg, notRecursive) {
  var localPath = getRemoteWorkspace(ftpConfig, remotePath);
  //if(fileUtil.existSync(localPath)) fileUtil.rmSync(localPath);
  if (!notMsg) vsUtil.msg("Please wait......Remote Info downloading... You can see 'output console'");
  //vsUtil.msg("Please wait......Remote Info downloading... You can see 'output console'");

  addJob(function (next) {
    stopWatch();
    removeRefreshRemoteTimer();
    emptyDownload(remotePath, localPath, function (err) {
      startWatch();
      setRefreshRemoteTimer();
      if (cb) cb(localPath);
      next();
    }, typeof notRecursive === 'number' ? notRecursive : undefined);
  });


  function emptyDownload(remotePath, localPath, cb, depth) {
    // if(remoteRefreshStopFlag)
    // {
    //   cb();
    //   return;
    // }    
    ftp.ls(remotePath, function (err, remoteFileList) {
      if (err && cb) cb();
      else {
        //if(remoteFileList.length > 0) 
        //{
        fileUtil.mkdirSync(localPath);
        //}
        // var last = remoteFileList.indexOf("node_modules");
        // if(last > -1)
        // {
        //   remoteFileList = remoteFileList.concat(remoteFileList.splice(last, 1));
        // }
        moveLast(remoteFileList);
        fileUtil.ls(localPath, function (err, localFileList) {
          loop(remoteFileList, function (i, value, next) {
            // if(remoteRefreshStopFlag)
            // {
            //   next();
            //   return;
            // }
            var remoteRealPath = pathUtil.join(remotePath, value.name);
            if (isIgnoreFile(ftpConfig, remoteRealPath)) {
              next();
            }
            else {
              var newFilePath = pathUtil.join(localPath, value.name);
              //수정본 시작
              fileUtil.stat(newFilePath, function (stat) {
                //console.log("newFilePath : ", newFilePath);
                //if(!stat)
                //{
                let recursive = typeof notRecursive === 'number' && depth > 0 || notRecursive === false || notRecursive === null || notRecursive === undefined;
                if (value.type === 'd') {
                  let tempDir = pathUtil.join(localPath, "[DIR] " + value.name);
                  if (recursive) {
                    //let tempDir = pathUtil.join(localPath, "[DIR] " + value.name);
                    fileUtil.exist(tempDir, function (bool) {
                      if (bool) fileUtil.rm(tempDir);
                    });
                    emptyDownload(remoteRealPath, newFilePath, next, typeof depth === 'number' ? depth - 1 : undefined);
                  }
                  else {
                    //newFilePath = pathUtil.join(localPath, "[DIR] " + value.name);
                    if (!stat) {
                      fileUtil.stat(tempDir, function (stat) {
                        if (!stat) {
                          make(tempDir, next);
                        }
                        else next();
                      });
                    }
                    else next();
                  }
                }
                else if (!stat) {
                  make(newFilePath, next);
                }
                else {
                  next();
                }
                //}
                //else next();
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
          }, function (err) {
            //if(!remoteRefreshStopFlag) deleteDiff(localFileList, remoteFileList);
            if (cb) cb(err);
          });
        });
      }
    });
  }
  function make(newFilePath, cb) {
    output("Remote info download : " + newFilePath);
    fileUtil.writeFile(newFilePath, "", function () {
      if (cb) cb();
    });
  }
  function deleteDiff(localList, remoteList) {
    for (var i = 0, ilen = localList.length; i < ilen; i++) {
      var exist = false;
      for (var j = 0, jlen = remoteList.length; j < jlen; j++) {
        if (localList[i].name === remoteList[j].name) {
          exist = true;
          break;
        }
      }
      if (!exist)// && localList[i].size === 0
      {
        var docs = vsUtil.getActiveFilePathAll();
        if (docs.indexOf(localList[i].path) === -1) {
          fileUtil.rm(localList[i].path);
        }
      }
    }
  }
}
function isRemoteTempWorkspaceFile(path) {
  return path.indexOf(REMOTE_WORKSPACE_TEMP_PATH) === 0;
}
function autoRefreshRemoteTempFiles(notMsg, loadAll, cb) {
  var workspacePath = vsUtil.getWorkspacePath();
  if (workspacePath) {
    if (remoteRefreshStopFlag) {
      cb();
      return;
    }
    var ftpConfigFromTempDir = getFTPConfigFromRemoteTempPath(workspacePath);
    if (ftpConfigFromTempDir.config && ftpConfigFromTempDir.path) {
      createFTP(ftpConfigFromTempDir.config, function (ftp) {
        //stopWatch();
        //console.log("loadAll-autoRefreshRemoteTempFiles : ", loadAll);
        downloadRemoteWorkspace(ftp, ftpConfigFromTempDir.config, ftpConfigFromTempDir.path, function () {
          if (!notMsg) vsUtil.msg("Remote Info downloading success.");
          if (cb) cb();
        }, notMsg, loadAll);
      });
    }
  }
}
function removeRefreshRemoteTimer() {
  clearTimeout(remoteRefreshFlag);
}
function setRefreshRemoteTimer(isNow) {
  var loadAll = vsUtil.getConfiguration("ftp-simple.remote-workspace-load-all");
  if (loadAll === false) loadAll = 1;
  else if (loadAll === true) loadAll = null;
  removeRefreshRemoteTimer();
  remoteRefreshFlag = setTimeout(function () {
    autoRefreshRemoteTempFiles(isNow ? false : true, loadAll, function () {
      if (isNow) setTimeout(function () { startWatch(); }, 3000);
    });
  }, isNow ? 0 : 1000 * 60 * 3);
}
function backup(ftp, ftpConfig, path, backupName, cb) {
  if (typeof backupName === 'function') {
    cb = backupName;
    backupName = undefined;
  }
  if (ftpConfig.backup) {
    fileUtil.mkdir(ftpConfig.backup, function (err) {
      if (err) {
        output("Backup folder create fail. Check your backup path : " + err.message);
        cb(err);
      }
      else {
        var now = backupName ? backupName : commonUtil.getNow().replace(/[^0-9]/g, '');
        var ymd = now.substring(0, 8);
        if (typeof path === 'string') {
          main(path, cb);
        }
        else if (path instanceof Array) {
          loop(path, function (i, value, next) {
            main(value, function (err) {
              next();
            });
          }, function () {
            cb();
          });
        }
        function main(path, cb) {
          var parent = pathUtil.getParentPath(path);
          var filename = pathUtil.getFileName(path);
          var backupFolder = pathUtil.join(ftpConfig.backup, ymd, now, parent);
          var savePath = pathUtil.join(backupFolder, filename);
          ftp.exist(path, function (result) {
            if (result) {
              ftp.download(path, savePath, function (err) {
                if (err) {
                  for (let o of err) {
                    output("Backup fail : " + o.message);
                  }
                }
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
  else {
    cb();
  }
}
function runAfterCheck(path, cb) {
  setTimeout(function () {
    if (path != vsUtil.getActiveFilePath()) {
      cb();
    }
  }, 100);
}
function deleteToRemoteTempPath(localFilePath, cb) {
  if (isRemoteTempWorkspaceFile(localFilePath)) {
    var ftpConfig = getFTPConfigFromRemoteTempPath(localFilePath);
    if (ftpConfig.config && ftpConfig.path) {
      createFTP(ftpConfig.config, function (ftp) {
        backup(ftp, ftpConfig, ftpConfig.path, function () {
          ftp.rm(ftpConfig.path, function (err) {
            if (!err) {
              fileUtil.rm(localFilePath, function (err) {
                output("Deleted : " + ftpConfig.path);
                if (cb) cb();
              });
            }
          });
        });
      });
    }
    return true;
  }
  else {
    vsUtil.msg("Context menu 'Delete' is only possible to remote file or directory.");
    if (cb) cb();
  }
  return false;
}
function updateToRemoteTempPath(remoteTempPath, existCheck, cb) {
  if (typeof existCheck === 'function') {
    cb = existCheck;
    existCheck = undefined;
  }
  remoteTempPath = pathUtil.normalize(remoteTempPath);
  var ftpConfig = getFTPConfigFromRemoteTempPath(remoteTempPath);
  if (ftpConfig.config && ftpConfig.path && ftpConfig.config.autosave === true) {
    if (REMOTE_TEMP_PATHS[remoteTempPath] === undefined) {
      REMOTE_TEMP_PATHS[remoteTempPath] = null;
    }
    var isDir = fileUtil.isDirSync(remoteTempPath);
    createFTP(ftpConfig.config, function (ftp) {
      if (existCheck || existCheck !== false && ftpConfig.config.confirm === true) {
        ftp.exist(ftpConfig.path, function (result) {
          if (!result) main();
          else {
            vsUtil.warning("Already exist " + (isDir ? "directory" : "file") + " '" + ftpConfig.path + "'. Overwrite?", "OK").then(function (btn) {
              if (btn == "OK") main();
              else deleteTempPath();
            });
          }
        });
      }
      else {
        fileUtil.stat(remoteTempPath, function (stats) {
          if (!isDir && stats.size == 0) {
            vsUtil.warning("Do you want to save(=upload) the empty file? (If the file exists on the server, overwrite it)", "OK").then(function (btn) {
              if (btn == "OK") main();
              else deleteTempPath();
            });
          }
          else main();
        });
      }

      function deleteTempPath() {
        var type = typeof REMOTE_TEMP_PATHS[remoteTempPath];
        if (type !== undefined) {
          if (type === 'function') {
            if (vsUtil.getActiveFilePathAll().indexOf(remoteTempPath) === -1) {
              REMOTE_TEMP_PATHS[remoteTempPath](function () {
                delete REMOTE_TEMP_PATHS[remoteTempPath];
              });
            }
          }
          else {
            delete REMOTE_TEMP_PATHS[remoteTempPath];
          }
        }
      }
      function main() {
        var fullPath = remoteTempPath + (isDir ? "/**" : "");
        remoteRefreshStopFlag = true;
        setTimeout(function () {
          backup(ftp, ftpConfig.config, ftpConfig.path, function (err) {
            ftp.upload(fullPath, ftpConfig.path, function (err) {
              //console.log("save upload : ", remoteTempPath + (isDir ? "/**" : ""));
              remoteRefreshStopFlag = false;
              if (err) output("upload fail : " + ftpConfig.path + " => " + err);
              else deleteTempPath();
              if (cb) {
                cb(err);
              }
            });
          });
        }, 10);
      }
    });
  }
  else if (CONFIG_PATH_TEMP == remoteTempPath) {
    var val = fs.readFileSync(CONFIG_PATH_TEMP).toString();
    try {
      val = JSON.parse(val);
      writeConfigFile(val);
    } catch (e) {
      vsUtil.error("Fail to save. Check Simple-FTP config file syntax.");
    }
  }
}
function startWatch() {
  if (watcher) return;
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





  watcher = chokidar.watch(vsUtil.getWorkspacePath(), { ignoreInitial: true, ignorePermissionErrors: true });
  watcher.on('add', (path, stats) => {
    path = pathUtil.normalize(path);
    if (stats && stats.size) {
      //console.log("watch add : ", path);
      addJob(function (next) {
        updateToRemoteTempPath(path, function (err) {
          if (!err) fileUtil.writeFile(path, "");
          next();
        });
      });
    }
  });
  watcher.on('addDir', (path) => {
    path = pathUtil.normalize(path);
    fileUtil.ls(path, function (err, list) {
      if (!err && list.length == 0) {
        //console.log("watch addDir : ", path);
        addJob(function (next) {
          updateToRemoteTempPath(path, function () { next(); });
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
function stopWatch() {
  console.log("stopWatch");
  if (watcher) watcher.close();
  watcher = null;
}
var watchJob = { job: [], flag: false };
function addJob(j) {
  watchJob.job.push(j);
  playJob();
}
function playJob() {
  if (watchJob.flag) return;
  watchJob.flag = true;
  var job = null;
  loop.while(function () {
    job = watchJob.job.shift();
    return job ? true : false;
  }, function (next) {
    job(next);
  }, function () {
    watchJob.flag = false;
  });
}
/**
 * 해당 워크스페이스가 프로젝트 설정 있는지 체크 후 정보 가져오기
 */
function getProjectPathInConfig() {
  var workspacePath = vsUtil.getWorkspacePath();
  var config = getConfig();
  var result = [];  //{config:ftpconfig, path:{local:path, remote:path}}
  if (config && config instanceof Array) {
    for (let o of config) {
      if (!o.project || typeof o.project !== 'object') continue;
      for (let k in o.project) {
        let v = o.project[k];
        if (v instanceof Array) {
          for (let a of v) {
            if (typeof a === 'object' && a.path) {
              let p = same(k, a.path);
              let save = a.save === true ? true : false;
              if (p) result.push({ config: o, path: p, autosave: save });
            }
            else if (typeof a === 'string') {
              let p = same(k, a);
              if (p) result.push({ config: o, path: p });
            }
          }
        }
        // else if(typeof v === 'object')
        // {
        //   var p = same(k, v.path);
        //   if(p) result.push({config:o, path:p, ignore:v.ignore});
        // }
        else if (typeof v === 'object' && v.path) {
          let p = same(k, v.path);
          let save = v.save === true ? true : false;
          if (p) result.push({ config: o, path: p, autosave: save });
        }
        else if (typeof v === 'string') {
          let p = same(k, v);
          if (p) result.push({ config: o, path: p });
        }
      }
    }
  }
  function same(key, val) {
    if (/^[A-Z]\:/.test(key)) {
      key = key.substring(0, 1).toLowerCase() + key.substring(1);
    }
    var arr = [key, pathUtil.normalize(key)];
    if (arr.indexOf(workspacePath) > -1) {
      return { local: pathUtil.normalize(key), remote: pathUtil.normalize(val) };
    }
    return null;
  }
  return result.length ? result : null;
}
function isIgnoreFile(ftpConfig, remotePath) {
  var result = false;
  if (ftpConfig.ignore && ftpConfig.ignore instanceof Array) {
    for (var v of ftpConfig.ignore) {
      var ignorePattern = pathUtil.join(ftpConfig.path, v);
      if (minimatch(remotePath, ignorePattern)) {
        result = true;
        break;
      }
    }
  }
  return result;
}
function addWaitList(path, isDir) {
  var relativePath = pathUtil.getRelativePath(vsUtil.getWorkspacePath(), path);
  var result = true;
  for (var o of waitList) {
    if (o.path === path || o.isDir && path.indexOf(o.path + "/") === 0) {
      result = false;
      break;
    }
  }
  if (result) {
    waitList.push({ path: path, label: relativePath, isDir: isDir, description: 'If selected, removed from the list' });
    if (isDir) {
      for (var i = waitList.length - 1; i >= 0; i--) {
        if (waitList[i].path.indexOf(path + "/") === 0) {
          waitList.splice(i, 1);
        }
      }
    }
    waitList.sort(function (a, b) {
      return a.path > b.path;
    });
    output("Add Wait path : " + relativePath);
  }
}
function deleteWaitList(path) {
  if (path) {
    var relativePath = pathUtil.getRelativePath(vsUtil.getWorkspacePath(), path);
    for (var i = 0; i < waitList.length; i++) {
      var o = waitList[i];
      if (o.path === path) {
        waitList.splice(i, 1);
        output("Delete wait path : " + relativePath);
        break;
      }
    }
  }
  else {
    waitList.length = 0;
    output("Delete all wait path.");
  }
}
function pickWaitList(cb) {
  const SAVE_ALL = { label: "= SAVE ALL =", description: 'from waiting list' };
  const DELETE_ALL = { label: "= DELETE ALL =", description: 'from waiting list' };
  const SAVE_DELETE = { label: "= SAVE ALL & DELETE ALL =", description: 'from waiting list' };
  const COPY = { label: "= COPY(EXTRACT) =", description: 'Copy the waiting list file to "copy_path"' };
  var waitLen = waitList.length;
  var pickList = waitList.concat([SAVE_ALL, DELETE_ALL, SAVE_DELETE]);
  if (WAIT_COPY_PATH && waitLen) {
    pickList.push(COPY);
  }
  vsUtil.pick(pickList, 'Select the path or action. Total : ' + waitLen, function (item) {
    if (item.path) {
      deleteWaitList(item.path);
      pickWaitList(cb);
    }
    else if (item.label === DELETE_ALL.label) {
      deleteWaitList();
      if (cb) cb();
    }
    else if (item.label === SAVE_ALL.label || item.label === SAVE_DELETE.label) {
      var newList = waitList;
      if (item.label === SAVE_DELETE.label) {
        newList = waitList.concat([]);
        deleteWaitList();
      }
      if (cb) cb(newList);
    }
    else if (item.label === COPY.label) {
      var now = commonUtil.getNow().replace(/\D/g, '');
      var workspacePath = vsUtil.getWorkspacePath();
      var projectName = pathUtil.getFileName(workspacePath);
      var destWorkspacePath = pathUtil.join(WAIT_COPY_PATH, projectName, now);
      loop(waitList, 10, function (i, value, next) {
        var localPath = pathUtil.join(workspacePath, value.label);
        var destPath = pathUtil.join(destWorkspacePath, value.label);
        fileUtil.copy(localPath, destPath, function (err) {
          if (!err) output(`Copyed : ${localPath} => ${destPath}`);
          next(err);
        });
      }, function (err) {
        if (err) output("Copy error : " + err);
        else output(`Copyed success(${waitLen}) : ${destWorkspacePath}`);
      });
    }
  });
}
function moveLast(list) {
  var len = list.length;
  var count = 0;
  var i = 0;
  while (count < len) {
    var name = list[i].name || list[i];
    if (name === 'node_modules') {
      list.push(list[i]);
      list.splice(i, 1);
    }
    else i++;
    count++;
  }
}
