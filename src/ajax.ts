// deno-lint-ignore-file no-explicit-any ban-types
import {
  AbortResult,
  AjaxConfig,
  AjaxExConfig,
  AjaxGetData,
  AjaxPostData,
  AjaxResult,
  ErrorCallback,
  Logger,
  RequestCallback,
  ResponseCallback,
} from "./types.ts";
import { deleteUndefinedProperty, jsonParse, md5 } from "./utils.ts";

class Interceptors<T extends Function> {
  chain: any[];

  constructor() {
    this.chain = [];
  }

  use(callback: T, errorCallback: ErrorCallback) {
    this.chain.push(callback, errorCallback);
    return this.chain.length - 2;
  }

  eject(index: number) {
    this.chain.splice(index, 2);
  }
}

export class FetchError extends Error {
  status?: number; // status code
  name = "FetchError";
  originError?: Error;

  constructor(message: string | Error | undefined, status?: number) {
    super(message instanceof Error ? message.message : message);
    if (message instanceof Error) {
      this.stack = message.stack;
      this.cause = message.cause;
      this.originError = message;
    }
    this.status = status;
  }
}

export class Ajax {
  static defaults: AjaxExConfig = {
    credentials: "include",
    mode: "cors",
    timeout: 1000 * 60 * 2,
    timeoutErrorMessage: "timeout",
    timeoutErrorStatus: 504,
    method: "post",
    defaultPutAndPostContentType: "application/json; charset=UTF-8",
    defaultInjectHeaderKeys: [
      "x-request-id",
      "x-b3-traceid",
      "x-b3-spanid",
      "x-b3-parentspanid",
      "x-b3-sampled",
    ],
  };

  private logger: Logger;

  constructor(logger?: Logger) {
    this.logger = logger || console;
  }

  public interceptors = {
    request: new Interceptors<RequestCallback>(),
    response: new Interceptors<ResponseCallback>(),
  };

  public caches = new Map(); // 缓存所有已经请求的Promise，同一时间重复的不再请求

  protected getUniqueKey(config: AjaxConfig) {
    const headers = config.headers;
    const keys = [
      config.baseURL,
      config.url,
      config.method,
      config.data ? JSON.stringify(config.data) : "",
    ];
    if (headers) {
      Object.keys(headers).forEach((key) =>
        keys.push(key + "=" + headers[key])
      );
    }
    return md5(keys.filter(Boolean).join("_"));
  }

  /** 手动清除缓存 */
  async clearCacheByConfig(cfg: AjaxConfig) {
    const mergedConfig = this.mergeConfig(cfg);
    const { cacheStore } = mergedConfig;
    const uniqueKey = this.getUniqueKey(mergedConfig);
    if (cacheStore) {
      await cacheStore.delete(uniqueKey);
    }
    this.clearCacheByKey(uniqueKey);
  }

  /**
   * 取消接口请求
   * @param controller 取消控制器
   */
  abort(controller?: AbortController) {
    controller?.abort();
  }

  /**
   * 取消所有接口请求
   */
  abortAll() {
    for (const cache of this.caches.values()) {
      this.abort(cache.controller);
    }
  }

  private handleGetUrl(url: string, data: AjaxGetData, isEncodeUrl?: boolean) {
    let tempUrl = url;
    if (typeof data === "object") {
      const exArr = [];
      for (const key in data) {
        exArr.push(key + "=" + data[key]);
      }
      if (exArr.length > 0) {
        const exUrl = isEncodeUrl
          ? encodeURI(encodeURI(exArr.join("&")))
          : exArr.join("&"); //这里怎么加密，与后台解密方式也有关。如果不是这样的格式，就自己拼接url
        if (!tempUrl.includes("?")) {
          tempUrl += "?" + exUrl;
        } else {
          tempUrl += "&" + exUrl;
        }
      }
    } else {
      if (data) {
        if (!tempUrl.includes("?")) {
          tempUrl += "?" + data;
        } else {
          tempUrl += "&" + data;
        }
      }
    }
    return tempUrl;
  }

  private handleBaseUrl(url: string, baseURL?: string) {
    if (url.startsWith("http")) {
      return url;
    }
    if (baseURL) {
      if (!baseURL.endsWith("/")) {
        baseURL += "/";
      }
      if (url.startsWith("/")) {
        url = url.substring(1);
      }
      return baseURL + url;
    }
    return url;
  }

  private handlePostData(data: any, isFile?: boolean) {
    let obj = data;
    if (typeof data === "object") {
      if (isFile) { //文件上传
        const formData = new FormData(); //构造空对象，下面用append方法赋值。
        for (const key in data) {
          if (!Object.prototype.hasOwnProperty.call(data, key)) {
            continue;
          }
          const value = data[key];
          if (key == "files" && Array.isArray(value)) {
            value.forEach((file) => formData.append(key, file));
          } else {
            formData.append(key, value); //例：formData.append("file", document.getElementById('fileName').files[0]);
          }
        }
        obj = formData;
      } else {
        obj = JSON.stringify(data);
      }
    }
    return obj;
  }

  /**
   * 进行fetch请求
   * @param config 配置
   */
  private async request(config: AjaxConfig) {
    const {
      url,
      baseURL, //前缀url
      data,
      query,
      headers = {},
      method,
      credentials,
      isFile,
      isUseOrigin,
      isEncodeUrl, //get请求时是否要进行浏览器编码
      ignore,
      defaultPutAndPostContentType,
      defaultInjectHeaderKeys,
      originHeaders,
      ...otherParams
    } = config;

    let tempUrl = this.handleBaseUrl(url, baseURL);
    let body: any;
    if (method.toUpperCase() === "GET") {
      body = null; //get请求不能有body
      tempUrl = this.handleGetUrl(tempUrl, data as AjaxGetData, isEncodeUrl);
    } else {
      if (query) {
        tempUrl = this.handleGetUrl(tempUrl, query, isEncodeUrl);
      }
      body = this.handlePostData(data, isFile);
      if (!isFile) {
        if (method.toUpperCase() === "POST" || method.toUpperCase() === "PUT") {
          if (
            !Object.keys(headers).find((key) =>
              key.toLowerCase() === "content-type"
            )
          ) {
            headers["content-type"] = defaultPutAndPostContentType!;
          }
        }
      }
    }
    if (originHeaders) {
      defaultInjectHeaderKeys!.forEach((key) => {
        const value = originHeaders.get(key);
        if (value) {
          headers[key] = value;
        }
      });
    }
    try {
      const response = await fetch(tempUrl, {
        headers,
        body,
        method,
        credentials,
        ...otherParams,
      });
      if (!response.ok) { // 状态码不是200到300，代表请求失败
        if (!(Array.isArray(ignore) && ignore.includes(response.status))) { // 如果不忽略错误码
          if (isUseOrigin) {
            return Promise.reject(response);
          }
          const msg = await response.text();
          const errMsg = msg || response.statusText;
          return Promise.reject(new FetchError(errMsg, response.status));
        }
      }
      if (isUseOrigin) {
        return response;
      }
      //以下处理成功的结果
      const result = await response.text();
      return jsonParse(result);
    } catch (err) { //代表网络异常
      return Promise.reject(new FetchError(err));
    }
  }

  isAbortError(err: Error) {
    return err.name === "AbortError";
  }

  private mergeAbortConfig(
    config: AjaxConfig,
    signal?: AbortSignal,
  ): AbortController | undefined {
    let controller;
    if (typeof AbortController === "function" && signal === undefined) { // 如果要自己控制取消请求，需要自己传递signal，或者使用isReturnAbort参数
      controller = new AbortController();
      config.signal = controller.signal;
    }
    return controller;
  }

  private mergeConfig(cfg: AjaxConfig): AjaxConfig {
    deleteUndefinedProperty(cfg);
    const config = Object.assign({}, Ajax.defaults, cfg); // 把默认值覆盖了
    const chain = this.interceptors.request.chain;
    for (let i = 0; i < chain.length; i += 2) {
      try {
        chain[i](config);
      } catch (e) {
        this.logger.error(e);
        chain[i + 1]?.(e); // TODO 这个作用没想好
        break;
      }
    }
    return config;
  }

  private mergeResponse(promise: Promise<any>) {
    const chain = this.interceptors.response.chain;
    for (let i = 0; i < chain.length; i += 2) {
      promise = promise.then(chain[i], chain[i + 1]);
    }
    return promise;
  }

  private clearCacheByKey(uniqueKey: string, cacheTimeout?: number) {
    if (cacheTimeout !== undefined) {
      if (cacheTimeout >= 0) { // 如果小于0，不清除
        setTimeout(() => {
          this.caches.delete(uniqueKey);
        }, cacheTimeout);
      }
    } else {
      this.caches.delete(uniqueKey);
    }
  }

  /**
   * 实现fetch的timeout 功能
   * @param fecthPromise fetch
   * @param controller 取消控制器
   * @param config
   */
  private fetch_timeout(
    fecthPromise: Promise<any>,
    controller: AbortController | undefined,
    config: AjaxConfig,
  ) {
    let tp: any;
    const timeout = config.timeout;
    const abortPromise = new Promise((_resolve, reject) => {
      tp = setTimeout(() => {
        this.abort(controller);
        reject(
          new FetchError(config.timeoutErrorMessage, config.timeoutErrorStatus),
        );
      }, timeout);
    });

    return Promise.race([fecthPromise, abortPromise]).then((res) => {
      clearTimeout(tp);
      return res;
    }, (err) => {
      clearTimeout(tp);
      return Promise.reject(err);
    });
  }

  private core_ajax(mergedConfig: AjaxConfig): AjaxResult {
    const { signal } = mergedConfig;
    const controller = this.mergeAbortConfig(mergedConfig, signal);
    const temp = this.request(mergedConfig);
    const promise = this.fetch_timeout(temp, controller, mergedConfig);
    return {
      promise: this.mergeResponse(promise),
      config: mergedConfig,
      controller,
    };
  }

  /**
   * 缓存请求，同一时间同一请求只会向后台发送一次
   */
  private cache_ajax(cfg: AjaxConfig): AjaxResult {
    const mergedConfig = this.mergeConfig(cfg);
    const { cacheTimeout, cacheStore, isDebug } = mergedConfig;
    if (cacheTimeout === 0) { // 不缓存结果，也就是说不会过滤掉重复的请求
      return this.core_ajax(mergedConfig);
    }
    if (mergedConfig.isUseOrigin) {
      this.logger.warn("使用origin时不允许缓存");
      return this.core_ajax(mergedConfig);
    }
    const uniqueKey = this.getUniqueKey(mergedConfig);
    const caches = this.caches;
    const result = caches.get(uniqueKey);
    if (result !== undefined) {
      if (isDebug) {
        this.logger.debug(`read from cache : ${uniqueKey}`);
      }
      result.isFromMemoryCache = true;
      return result;
    }
    if (cacheStore) { // 有cacheStore，处理要复杂一些，先缓存到内存，等成功后再注入到store中
      const result: AjaxResult = {
        promise: Promise.resolve(cacheStore.get(uniqueKey)),
        config: mergedConfig,
      };
      result.promise = result.promise.then((res) => {
        if (res !== undefined && res !== null) {
          if (isDebug) {
            this.logger.debug(`read from cacheStore : ${uniqueKey}`);
          }
          result.isFromStoreCache = true;
          return res;
        }
        const coreResult = this.core_ajax(mergedConfig);
        return coreResult.promise;
      }).then(async (res) => {
        if (!result.isFromStoreCache) {
          try {
            await cacheStore.set(
              uniqueKey,
              res,
              mergedConfig.cacheTimeout
                ? {
                  ttl: mergedConfig.cacheTimeout / 1000, // ttl单位设定为秒
                }
                : undefined,
            );
          } catch (err) {
            this.logger.error(`cache set ${uniqueKey} error`, err);
          }
        }
        this.clearCacheByKey(uniqueKey); // 成功后在内存中删除
        return res;
      }, (err) => {
        this.clearCacheByKey(uniqueKey); // 错误不缓存
        return Promise.reject(err);
      });
      caches.set(uniqueKey, result);
      return result;
    } else {
      const result = this.core_ajax(mergedConfig);
      result.promise = result.promise.then((res) => {
        this.clearCacheByKey(uniqueKey, mergedConfig.cacheTimeout);
        return res;
      }, (err) => {
        this.clearCacheByKey(uniqueKey); // 错误不缓存
        return Promise.reject(err);
      });
      caches.set(uniqueKey, result);
      return result;
    }
  }

  all_ajax(cfg: AjaxConfig): AjaxResult {
    return this.cache_ajax(cfg);
  }

  /**
   * ajax主方法，返回promise
   */
  ajax<T>(cfg: AjaxConfig): Promise<T> {
    const result = this.all_ajax(cfg);
    return result.promise as Promise<T>;
  }

  /**
   * 调用ajax的同时，返回取消ajax请求的方法
   */
  ajaxAbortResult<T>(cfg: AjaxConfig): AbortResult<T> {
    const result = this.all_ajax(cfg);
    return {
      promise: result.promise as Promise<T>,
      abort: () => {
        return this.abort(result.controller);
      },
    };
  }

  get<T>(url: string, data?: AjaxGetData, options?: AjaxExConfig) {
    return this.ajax<T>({
      url,
      method: "get",
      data,
      ...options,
    });
  }

  /**
   * 调用ajax的get请求的同时，返回取消ajax请求的方法
   */
  getAbortResult<T>(url: string, data?: AjaxGetData, options?: AjaxExConfig) {
    return this.ajaxAbortResult<T>({
      url,
      method: "get",
      data,
      ...options,
    });
  }

  post<T>(url: string, data: AjaxPostData, options?: AjaxExConfig) {
    return this.ajax<T>({
      url,
      method: "post",
      data,
      ...options,
    });
  }

  /**
   * 调用ajax的post请求同时，返回取消ajax请求的方法
   */
  postAbortResult<T>(url: string, data: AjaxPostData, options?: AjaxExConfig) {
    return this.ajaxAbortResult<T>({
      url,
      method: "post",
      data,
      ...options,
    });
  }
}
