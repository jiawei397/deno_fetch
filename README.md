# 封装的 fetch

[![deno version](https://img.shields.io/badge/deno-^2.0.0-blue?logo=deno)](https://github.com/denoland/deno)
[![Deno](https://github.com/jiawei397/deno_fetch/actions/workflows/deno.yml/badge.svg)](https://github.com/jiawei397/deno_fetch/actions/workflows/deno.yml)

## 包含功能点

- 同一时间段重复请求会被缓存过滤掉
- timeout
- 取消请求
- 支持自定义 cache
  store，比如`localStorage`，也可以是实现了`ICacheStore`接口的数据库

## 使用

### 封装 ajax

```ts
import Ajax from "@jw397/fetch";

Ajax.defaults.baseURL = "/api";

export const ajax = new Ajax();
```

默认在同一时间请求的接口（即还没有响应），会过滤掉，只请求一次。规则是对 baseURL、url、method、data、headers 作为唯一 key，代码如下：

```ts
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
```

这个方法可以重写。

### 拦截

```ts
// 请求拦截
ajax.interceptors.request.use(
  function (mergedConfig) {
    mergedConfig.headers = mergedConfig.headers || {};
    mergedConfig.headers.token = "abcd";
    return mergedConfig;
  },
  function (err) {
    throw err;
  }
);

// 响应拦截
ajax.interceptors.response.use(
  function (data) {
    return data.slice(0, 10);
  },
  function (err) {
    return Promise.reject(err);
  }
);
```

### 获取可取消的请求

```ts
const { promise, abort } = ajax.getAbortResult(url, data, options);
promise.then((result) => console.log(result));
abort(); // 取消请求

const { promise2, abort2 } = ajax.postAbortResult(url, data, options);
promise2.then((result) => console.log(result));
abort2(); // 取消请求
```

## ajax 配置项

### url

Type: `string`

### method

Type: `string`

一般是 get、post

### baseURL

Type: `string`

请求 url 的前缀

### headers

Type: `any`

添加的请求头

### data

Type: `any`

请求数据，一般是个对象{}。

### timeout

Type: `number`

Default: `2 * 60 * 1000`，2 分钟

过期时间，单位 ms。从请求开始，到这个时间如果接口没有响应，则会返回一个失败的 promise。

### timeoutErrorMessage

Type: `string`

Default: `timeout`

过期时间错误提示

### timeoutErrorStatus

Type: `number`

Default: `504`

过期时间状态码

### credentials

Type: `string`

Default: `include`

- omit：忽略 cookie 的发送
- same-origin: 表示 cookie 只能同域发送，不能跨域发送
- include: cookie 既可以同域发送，也可以跨域发送

### mode

Type: `string`

Default: `cors`

- same-origin：该模式是不允许跨域的，它需要遵守同源策略，否则浏览器会返回一个 error 告知不能跨域；其对应的 response
  type 为 basic。
- cors:
  该模式支持跨域请求，顾名思义它是以 CORS 的形式跨域；当然该模式也可以同域请求不需要后端额外的 CORS 支持；其对应的 response
  type 为 cors。
- no-cors:
  该模式用于跨域请求但是服务器不带 CORS 响应头，也就是服务端不支持 CORS；这也是 fetch 的特殊跨域请求方式；其对应的 response
  type 为 opaque。

### isFile

Type: `boolean`

是否属于文件上传，如果是这样，会根据传递的 data，创建一个 FormData

### isUseOrigin

Type: `boolean`

为 true 时，直接返回 response，不再处理结果。
一般返回结果不是 json 对象，比如是流时需要设置此项。

### isEncodeUrl

Type: `boolean`

get 请求时是否要进行浏览器编码

### signal

Type: `AbortSignal`

主动控制取消请求时可传递此参数，或者直接使用`ajaxAbortResult`方法。例如：

```typescript
const controller = new AbortController();
const { signal } = controller;
```

### cacheTimeout

Type: `number`

缓存时间

- 如果是-1，代表不清除缓存。
- 如果是 0，代表不使用缓存。
- 如果大于 0，代表要缓存多长时间，单位是 ms。

### originHeaders

Type: `Headers`

如果本身是在接口里进行的二次请求，传递原始的 headers

### defaultInjectHeaderKeys

Type: `string[]`

Default:
`["x-request-id", "x-b3-traceid", "x-b3-spanid", "x-b3-parentspanid", "x-b3-sampled"]`

配合 originHeaders 使用，如果有这几个字段，将会默认注入

### cacheStore

Type: `ICacheStore`

可以参考`src/store.ts`这个文件中的`LocalStore`，数据存储在`localStorage`中。

```typescript
export interface LocalValue {
  td: number | undefined;
  value: any;
}
export class LocalStore implements ICacheStore {
  timeoutMap: Map<string, number>;

  constructor() {
    this.timeoutMap = new Map<string, number>();
  }

  get(key: string) {
    const val = localStorage.getItem(key);
    if (val) {
      const json = JSON.parse(val) as LocalValue;
      // console.log("get json", json);
      if (json.td && Date.now() >= json.td) {
        // expired
        // console.debug(`Cache expired: ${key} and will be deleted`);
        this.delete(key);
        return;
      }
      return json.value;
    }
  }
  set(key: string, value: any, options?: { ttl: number }) {
    const val: LocalValue = {
      td: options?.ttl ? Date.now() + options.ttl * 1000 : undefined,
      value,
    };
    localStorage.setItem(key, JSON.stringify(val));
    if (options?.ttl) {
      const st = setTimeout(() => {
        this.delete(key);
      }, options.ttl * 1000);
      this.timeoutMap.set(key, st);
    }
  }
  delete(key: string) {
    localStorage.removeItem(key);
    clearTimeout(this.timeoutMap.get(key));
    this.timeoutMap.delete(key);
  }
  clear(): void | Promise<void> {
    localStorage.clear();
    for (const st of this.timeoutMap.values()) {
      clearTimeout(st);
    }
    this.timeoutMap.clear();
  }
  has(key: string): boolean | Promise<boolean> {
    return localStorage.getItem(key) !== null;
  }
  size(): number | Promise<number> {
    return localStorage.length;
  }
}
```

### revalidateTime

Type: `number`

`revalidateTime`是指在缓存仍在有效期时，后台重新请求接口以更新缓存的时间间隔。单位是 ms。

如果配置了`revalidateTime`，会优先响应缓存，适用于对实时性没有那么高的特殊场景，比如官网。
