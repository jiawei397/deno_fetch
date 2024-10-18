// deno-lint-ignore-file no-explicit-any
import type {
  AbortResult,
  AjaxConfig,
  AjaxExConfig,
  AjaxGetData,
  AjaxPostData,
  AjaxResult,
  ErrorRequestCallback,
  ErrorResponseCallback,
  Logger,
  RequestCallback,
  ResponseCallback,
} from "./types.ts";
import { deleteUndefinedProperty, md5, resolveUrl } from "./utils.ts";

class Interceptors<T, E> {
  public chain: any[];

  constructor() {
    this.chain = [];
  }

  use(callback: T, errorCallback: E): number {
    this.chain.push(callback, errorCallback);
    return this.chain.length - 2;
  }

  eject(index: number) {
    this.chain.splice(index, 2);
  }
}

export enum FetchErrorType {
  Network = "network",
  // Abort = "abort", // 不存在外部手动取消的情况
  Timeout = "timeout",
  HTTP = "http",
}

export class FetchError extends Error {
  override name = "FetchError";
  originError?: any;

  constructor(
    message: string | Error | Record<string, any>,
    public type: FetchErrorType,
    public config: AjaxConfig,
    public status?: number
  ) {
    super(typeof message === "string" ? message : message.message);
    if (typeof message !== "string") {
      if (message instanceof Error) {
        this.stack = message.stack;
        this.cause = message.cause;
      }
      this.originError = message;
    }
    this.type = type;
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
    isDebug: false,
  };

  defaultConfig: AjaxExConfig;
  logger: Logger;

  constructor(defaultConfig?: AjaxExConfig) {
    this.defaultConfig = { ...Ajax.defaults, ...defaultConfig };
    this.logger = this.defaultConfig.logger || console;
  }

  public interceptors: {
    request: Interceptors<RequestCallback, ErrorRequestCallback>;
    response: Interceptors<ResponseCallback, ErrorResponseCallback>;
  } = {
    request: new Interceptors(),
    response: new Interceptors(),
  };

  public caches: Map<string, any> = new Map(); // 缓存所有已经请求的Promise，同一时间重复的不再请求。TODO：类型可能有问题

  public cachesTimeoutKeyMap: Map<string, number> = new Map(); // 用于存储缓存的key的过期时间
  public revalidateCacheTimeoutKeyMap: Map<string, number> = new Map(); // 用于存储需要重新请求的key的过期时间
  public fetchTimeoutKeys: Set<number> = new Set(); // 用于存储fetch的key的过期时间

  protected getUniqueKey(config: AjaxConfig): string {
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
    this.clearAllTimeout();
  }

  /**
   * 清除所有缓存的timeout
   */
  clearAllTimeout() {
    for (const timeout of this.cachesTimeoutKeyMap.values()) {
      clearTimeout(timeout);
    }
    this.cachesTimeoutKeyMap.clear();
    for (const timeout of this.revalidateCacheTimeoutKeyMap.values()) {
      clearTimeout(timeout);
    }
    this.revalidateCacheTimeoutKeyMap.clear();
    for (const timeout of this.fetchTimeoutKeys.values()) {
      clearTimeout(timeout);
    }
    this.fetchTimeoutKeys.clear();
  }

  private handleGetUrl(url: string, data: AjaxGetData, isEncodeUrl?: boolean) {
    let tempUrl = url;
    if (typeof data === "object") {
      const exArr: string[] = [];
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

  private handlePostData(data: any, isFile?: boolean) {
    let obj = data;
    if (typeof data === "object") {
      if (isFile) {
        //文件上传
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
      responseHeaderKeys,
      ...otherParams
    } = config;

    let tempUrl = resolveUrl(url, baseURL);
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
            !Object.keys(headers).find(
              (key) => key.toLowerCase() === "content-type"
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
      if (!response.ok) {
        // 状态码不是200到300，代表请求失败
        if (!(Array.isArray(ignore) && ignore.includes(response.status))) {
          // 如果不忽略错误码
          const msg = await response.text();
          const errMsg = msg || response.statusText;
          return Promise.reject(
            new FetchError(errMsg, FetchErrorType.HTTP, config, response.status)
          );
        }
      }
      if (isUseOrigin) {
        return response;
      }
      //以下处理成功的结果
      const contentType = response.headers.get("content-type");
      const result = contentType?.includes("application/json")
        ? await response.json()
        : await response.text();
      const resHeaders: Record<string, string | null> = {};
      if (responseHeaderKeys) {
        responseHeaderKeys.forEach((key) => {
          resHeaders[key] = response.headers.get(key);
        });
      }
      return {
        data: result,
        headers: resHeaders,
      };
    } catch (err) {
      //代表网络异常
      return Promise.reject(
        new FetchError(err as Error, FetchErrorType.Network, config)
      );
    }
  }

  isAbortError(err: Error): boolean {
    return err.name === "AbortError";
  }

  private mergeAbortConfig(
    config: AjaxConfig,
    signal?: AbortSignal
  ): AbortController | undefined {
    let controller;
    if (typeof AbortController === "function" && signal === undefined) {
      // 如果要自己控制取消请求，需要自己传递signal，或者使用isReturnAbort参数
      controller = new AbortController();
      config.signal = controller.signal;
    }
    return controller;
  }

  private mergeConfig(cfg: AjaxConfig): AjaxConfig {
    deleteUndefinedProperty(cfg);
    const config = Object.assign({}, this.defaultConfig, cfg); // 把默认值覆盖了
    const chain = this.interceptors.request.chain;
    for (let i = 0; i < chain.length; i += 2) {
      try {
        chain[i](config);
      } catch (e) {
        chain[i + 1]?.(e);
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
      if (cacheTimeout >= 0) {
        // 如果小于0，不清除
        const t = setTimeout(() => {
          this.caches.delete(uniqueKey);
          this.cachesTimeoutKeyMap.delete(uniqueKey);
        }, cacheTimeout);
        this.cachesTimeoutKeyMap.set(uniqueKey, t);
      }
    } else {
      this.caches.delete(uniqueKey);
    }
  }

  /**
   * 实现fetch的timeout 功能
   * @param fetchPromise fetch
   * @param controller 取消控制器
   * @param config
   */
  private fetch_timeout(
    fetchPromise: Promise<any>,
    controller: AbortController | undefined,
    config: AjaxConfig
  ) {
    let tp: number;
    const timeout = config.timeout;
    const abortPromise = new Promise((_resolve, reject) => {
      tp = setTimeout(() => {
        this.abort(controller);
        this.fetchTimeoutKeys.delete(tp);
        reject(
          new FetchError(
            config.timeoutErrorMessage!,
            FetchErrorType.Timeout,
            config,
            config.timeoutErrorStatus
          )
        );
      }, timeout);
      this.fetchTimeoutKeys.add(tp);
    });

    return Promise.race([fetchPromise, abortPromise]).then(
      (res) => {
        clearTimeout(tp);
        this.fetchTimeoutKeys.delete(tp);
        if (config.isUseOrigin) {
          return res;
        }
        if (config.responseHeaderKeys) {
          return res;
        }
        return res.data;
      },
      (err) => {
        clearTimeout(tp);
        this.fetchTimeoutKeys.delete(tp);
        return Promise.reject(err);
      }
    );
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

  private logDebug(message: string, isDebug?: boolean): void {
    if (isDebug) {
      this.logger.debug(message);
    }
  }

  /**
   * 缓存请求，同一时间同一请求只会向后台发送一次
   */
  private cache_ajax(cfg: AjaxConfig, isRevalidate: boolean): AjaxResult {
    const mergedConfig = this.mergeConfig(cfg);
    const { cacheTimeout, cacheStore, isDebug } = mergedConfig;
    if (cacheTimeout === 0) {
      // 不缓存结果，也就是说不会过滤掉重复的请求
      return this.core_ajax(mergedConfig);
    }
    if (mergedConfig.isUseOrigin) {
      this.logger.warn("isUseOrigin is true, will not use cache");
      return this.core_ajax(mergedConfig);
    }
    const uniqueKey = this.getUniqueKey(mergedConfig);
    const caches = this.caches;
    const cacheResult = caches.get(uniqueKey);
    const result: AjaxResult = {
      promise: Promise.resolve(
        isRevalidate ? null : cacheResult || cacheStore?.get(uniqueKey)
      ),
      config: mergedConfig,
    };
    if (cacheResult !== undefined && cacheResult !== null) {
      this.logDebug(`Read from cache : ${uniqueKey}`, isDebug);
      result.isFromMemoryCache = true;
    }
    result.promise = result.promise
      .then((res) => {
        if (res !== undefined && res !== null) {
          // 读取到了缓存
          if (cacheStore && !result.isFromMemoryCache) {
            this.logDebug(`Read from cacheStore : ${uniqueKey}`, isDebug);
            result.isFromStoreCache = true;
          }
          if (mergedConfig.revalidateTime !== undefined) {
            // 如果设置了revalidateTime，那么隔一段时间重新请求一次
            if (!this.revalidateCacheTimeoutKeyMap.has(uniqueKey)) {
              const t = this.cachesTimeoutKeyMap.get(uniqueKey);
              if (t) {
                clearTimeout(t);
                this.cachesTimeoutKeyMap.delete(uniqueKey);
              }
              const t2 = setTimeout(() => {
                this.cache_ajax(cfg, true)
                  .promise.catch((err) => {
                    this.logger.error(
                      `Revalidate caused error, config: ${JSON.stringify(
                        cfg
                      )}, uniqueKey: ${uniqueKey}, error: ${err.stack}`
                    );
                  })
                  .finally(() => {
                    this.revalidateCacheTimeoutKeyMap.delete(uniqueKey);
                  });
              }, mergedConfig.revalidateTime);
              this.revalidateCacheTimeoutKeyMap.set(uniqueKey, t2);
            }
          }
          return res;
        }
        const coreResult = this.core_ajax(mergedConfig);
        return coreResult.promise;
      })
      .then(
        async (res) => {
          if (!result.isFromStoreCache && cacheStore) {
            // 缓存不是从cacheStore读取的，那么就缓存到cacheStore
            try {
              await cacheStore.set(
                uniqueKey,
                res,
                mergedConfig.cacheTimeout
                  ? {
                      ttl: mergedConfig.cacheTimeout / 1000, // ttl单位设定为秒
                    }
                  : undefined
              );
            } catch (err) {
              this.logger.error(`cacheStore set ${uniqueKey} error`, err);
            }
          }
          if (cacheStore) {
            this.clearCacheByKey(uniqueKey); // 成功后在内存中删除
          } else {
            if (!result.isFromMemoryCache) {
              this.clearCacheByKey(uniqueKey, mergedConfig.cacheTimeout);
            }
          }
          return res;
        },
        (err) => {
          this.clearCacheByKey(uniqueKey); // 错误不缓存
          return Promise.reject(err);
        }
      );
    caches.set(uniqueKey, result.promise);
    return result;
  }

  all_ajax(cfg: AjaxConfig): AjaxResult {
    return this.cache_ajax(cfg, false);
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

  get<T>(url: string, data?: AjaxGetData, options?: AjaxExConfig): Promise<T> {
    return this.ajax<T>({
      url,
      method: "get",
      data,
      ...options,
    });
  }

  getWithHeaders<T>(
    url: string,
    data?: AjaxGetData,
    options?: AjaxExConfig
  ): Promise<{
    data: T;
    headers: Record<string, string | null>;
  }> {
    if (!options?.responseHeaderKeys?.length) {
      throw new Error("responseHeaderKeys cannot be empty");
    }
    return this.ajax<{
      data: T;
      headers: Record<string, string | null>;
    }>({
      url,
      method: "get",
      data,
      ...options,
    });
  }

  /**
   * 调用ajax的get请求的同时，返回取消ajax请求的方法
   */
  getAbortResult<T>(
    url: string,
    data?: AjaxGetData,
    options?: AjaxExConfig
  ): AbortResult<T> {
    return this.ajaxAbortResult<T>({
      url,
      method: "get",
      data,
      ...options,
    });
  }

  post<T>(url: string, data: AjaxPostData, options?: AjaxExConfig): Promise<T> {
    return this.ajax<T>({
      url,
      method: "post",
      data,
      ...options,
    });
  }

  postWithHeaders<T>(
    url: string,
    data: AjaxPostData,
    options?: AjaxExConfig
  ): Promise<T> {
    if (!options?.responseHeaderKeys?.length) {
      throw new Error("responseHeaderKeys cannot be empty");
    }
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
  postAbortResult<T>(
    url: string,
    data: AjaxPostData,
    options?: AjaxExConfig
  ): AbortResult<T> {
    return this.ajaxAbortResult<T>({
      url,
      method: "post",
      data,
      ...options,
    });
  }
}
