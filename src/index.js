const url = require('url');
const request = require('request-promise');
const _ = require('lodash');
const path = require('path');

const Qiniu = require('./qiniu');
const { combineFiles } = require('./utils');

const LOG_FILENAME = '__qiniu__webpack__plugin__files.json';

/**
 * options: {
 *    accessKey: '', @required
 *    secretKey: '', @required
 *    bucket: '', @required
 *    bucketDomain: '', @required
 *    ignoreFiles: [],
 *    uploadPath: '',
 * }
 */
class QiniuPlugin {
  constructor(options) {
    const defaultOptions = {
      
    }
    this.options = Object.assign(defaultOptions, options);
    let { uploadPath } = this.options;

    if (uploadPath && uploadPath[0] === '/') {
      this.options.uploadPath = uploadPath.slice(1, uploadPath.length);
    }
    
    const { accessKey, secretKey, bucket, bucketDomain } = this.options;
    
    this.publicPath = url.resolve(bucketDomain, uploadPath);

    this.qiniu = new Qiniu({
      accessKey,
      secretKey,
      bucket,
      domain: bucketDomain
    })
  }

  apply (compiler) {
    compiler.plugin('before-run', (compiler, callback) => {
      compiler.options.output.publicPath = this.publicPath;
      callback();
    })

    compiler.plugin('after-emit', async (compilation, callback) => {
      const fileNames = Object.keys(compilation.assets);

      /**
       * 对于一些文件名没带 hash 的，怎么处理？？
       * 将每个文件生成一遍 md5，存起来，下次上传时，再校验一遍？？
       */
      // 处理文件过滤
      const releaseFiles = fileNames;

      // 获取文件日志
      const {
        prev: prevFiles = [],
        current: currentFiles = []
      } = await this.getLogFile();

      console.log(`currentFiles: ${currentFiles}, prevFiles: ${prevFiles}`);

      // 合并去重，提取最终要上传和删除的文件
      const { uploadFiles, deleteFiles } = combineFiles(prevFiles, currentFiles, releaseFiles);
      try {
        // 上传
        for(let i = 0, len = uploadFiles.length; i < len; i ++) {
          const filename = uploadFiles[i];
          const file = compilation.assets[filename];

          const key = path.join(this.options.uploadPath, filename);  //  -> uploadPath/filename
          const localPath = file.existsAt;
          console.log(`[upload]: key: ${key}`);

          let res = await this.qiniu.putFile(key, localPath);
        }
      } catch(e) {
        console.log('[upload] error: ',e );
      }

      // 当有文件要上传才去删除之前版本的文件，且写入日志
      if (uploadFiles.length > 0) {
        await this.deleteOldFiles(deleteFiles);
        await this.writeLogFile(currentFiles, releaseFiles);
      }

      callback();
    });
  }
  
  /**
   * 删除旧的文件
   * @param {Array<string>} deleteFiles 待删除文件列表
   */
  async deleteOldFiles(deleteFiles) {
    if (deleteFiles.length > 0) {
      console.log('deleteFiles', deleteFiles);
      const keys = deleteFiles.map((filename, index) => path.join(this.options.uploadPath, filename));
      await this.qiniu.batchDelete(keys);
    }
  }

  /**
   * 记录文件列表
   * @param {Array<string>} currentFiles 当前线上的文件列表
   * @param {Array<string>} releaseFiles 等待发布的文件列表
   */
  async writeLogFile(currentFiles, releaseFiles) {
    let json = JSON.stringify({
      prev: currentFiles,
      current: releaseFiles,
      uploadTime: new Date()
    });
    const key = path.join(this.options.uploadPath, LOG_FILENAME);
    return await this.qiniu.put(key, json);
  }

  /**
   * 获取文件列表
   */
  async getLogFile() {
    let remotePath = path.join(this.options.uploadPath, LOG_FILENAME);
    let logDownloadUrl = this.qiniu.getPublicDownloadUrl(remotePath);

    let randomParams = '?r=' + +new Date();
    
    return request({
      uri: logDownloadUrl + randomParams,
      json: true
    })
    .catch(err => ({ prev: [], current: [] }))
  }
  
}

module.exports = QiniuPlugin;

