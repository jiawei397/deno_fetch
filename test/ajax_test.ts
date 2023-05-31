// deno-lint-ignore-file no-explicit-any
// Copyright 2018-2021 the oak authors. All rights reserved. MIT license.
import {
  assert,
  assertEquals,
  beforeEach,
  delay,
  describe,
  it,
  mf,
} from "../test_deps.ts";
import { ICacheStore } from "../mod.ts";
import { Ajax } from "../src/ajax.ts";
import { LocalStore, LocalValue } from "../src/store.ts";

describe("ajax", () => {
  function mock() {
    mf.install();

    mf.mock("GET@/api/", () => {
      return new Response(`ok`, {
        status: 200,
      });
    });
  }

  mock();

  let ajax: Ajax;

  beforeEach(() => {
    ajax = new Ajax();
  });

  const request = () => ajax.get("http://localhost/api/");

  describe("request and response count", () => {
    let requestCount = 0;
    let responseCount = 0;

    beforeEach(() => {
      requestCount = 0;
      responseCount = 0;

      ajax.interceptors.request.use(function (mergedConfig) {
        requestCount++;
        return mergedConfig;
      }, function (err) {
        requestCount++;
        return Promise.reject(err);
      });

      // 响应拦截
      ajax.interceptors.response.use(function (data) {
        responseCount++;
        return data;
      }, function (err) {
        responseCount++;
        return Promise.reject(err);
      });
    });

    it("once", async () => {
      assertEquals(requestCount, 0);
      assertEquals(responseCount, 0);

      await request();
      assertEquals(requestCount, 1);
      assertEquals(responseCount, 1);
    });

    it("many", async () => {
      assertEquals(requestCount, 0);
      assertEquals(responseCount, 0);

      for (let i = 0; i < 5; i++) {
        await request();
      }
      assertEquals(requestCount, 5);
      assertEquals(responseCount, 5);
    });
  });

  describe("response count", () => {
    it("once", async () => {
      let count = 0;
      await request().then(() => {
        count++;
      });
      assertEquals(count, 1);
    });
  });
});

Deno.test("error", async (it) => {
  function mock() {
    mf.install();

    mf.mock("POST@/error/", () => {
      return new Response(`ok`, {
        status: 401,
      });
    });

    mf.mock("GET@/error/", () => {
      return new Response(`ok`, {
        status: 401,
      });
    });
  }

  mock();

  await it.step("request and response", async () => {
    const ajax = new Ajax();
    const callStacks: number[] = [];
    await ajax.post("http://localhost/error/", {}).catch(() => {
      callStacks.push(1);
    });
    assertEquals(callStacks, [1]);

    await ajax.get("http://localhost/error/").catch(() => {
      callStacks.push(2);
    });
    assertEquals(callStacks, [1, 2]);
  });
});

Deno.test("error should not cached", async (it) => {
  const callStacks: number[] = [];
  function mock() {
    mf.install();

    mf.mock("GET@/error2/", () => {
      callStacks.push(2);
      return new Response(`ok`, {
        status: 401,
      });
    });
  }

  mock();

  await it.step("not cached", async () => {
    const ajax = new Ajax();

    await ajax.get("http://localhost/error2/").catch(() => {
      callStacks.push(1);
    });
    assertEquals(callStacks, [2, 1]);

    await ajax.get("http://localhost/error2/").catch(() => {
      callStacks.push(3);
    });
    assertEquals(callStacks, [2, 1, 2, 3], "will not be cached");

    callStacks.length = 0;
  });

  await it.step("not cached by set cachetimeout", async () => {
    const ajax = new Ajax();

    await ajax.get("http://localhost/error2/", null, {
      cacheTimeout: 1000,
    }).catch(() => {
      callStacks.push(1);
    });
    assertEquals(callStacks, [2, 1]);

    await ajax.get("http://localhost/error2/", null, {
      cacheTimeout: 1000,
    }).catch(() => {
      callStacks.push(3);
    });
    assertEquals(callStacks, [2, 1, 2, 3], "will not be cached");

    callStacks.length = 0;
  });
});

Deno.test("use cache store", async (it) => {
  const callStacks: number[] = [];
  function mock() {
    mf.install();

    mf.mock("GET@/test", () => {
      callStacks.push(1);
      return new Promise((resolve) => {
        setTimeout(() => {
          resolve(new Response(`ok`));
        }, 100);
      });
    });
  }

  mock();

  class LocalStore implements ICacheStore {
    timeoutMap: Map<string, number>;

    constructor() {
      this.timeoutMap = new Map<string, number>();
    }

    get(key: string) {
      callStacks.push(2);
      const val = localStorage.getItem(key);
      if (val) {
        callStacks.push(5);
        const json = JSON.parse(val) as LocalValue;
        // console.log("get json", json);
        if (json.td && Date.now() >= json.td) { // expired
          callStacks.push(6);
          // console.debug(`Cache expired: ${key} and will be deleted`);
          this.delete(key);
          return;
        }
        callStacks.push(7);
        return json.value;
      }
    }
    set(key: string, value: any, options?: { ttl: number }) {
      callStacks.push(3);
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
      callStacks.push(4);
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

  await it.step("cached in memory and push to store", async () => {
    localStorage.clear();
    const ajax = new Ajax();
    const store = new LocalStore();
    const promise1 = ajax.get("http://localhost/test", null, {
      cacheStore: store,
    });
    const promise2 = ajax.get("http://localhost/test", null, {
      cacheStore: store,
    });
    assertEquals(callStacks, [2]);

    await promise1;
    await promise2;
    assertEquals(callStacks, [2, 1, 3]);

    callStacks.length = 0;
    store.clear();
  });

  await it.step("get cache from store", async () => {
    localStorage.clear();
    callStacks.length = 0;

    const ajax = new Ajax();
    const store = new LocalStore();
    const request = () => {
      return ajax.get("http://localhost/test", null, {
        cacheStore: store,
        cacheTimeout: 500,
      });
    };
    const promise1 = request();
    const promise2 = request();
    assertEquals(callStacks, [2]);

    await promise1;
    await promise2;
    assertEquals(callStacks, [2, 1, 3]);

    callStacks.length = 0;

    {
      const promise3 = request();

      await promise3;
      // 这次应该是从store中读取的数据
      assertEquals(callStacks, [2, 5, 7]);
      callStacks.length = 0;
    }

    await delay(1000);

    {
      await request();
      // 数据被清除，从store没有读取到数据，这时
      assertEquals(callStacks, [4, 2, 1, 3]);

      callStacks.length = 0;
    }

    store.clear();
    callStacks.length = 0;
  });
});

Deno.test("isFromCache", async (it) => {
  const callStacks: number[] = [];
  function mock() {
    mf.install();

    mf.mock("GET@/test", () => {
      callStacks.push(2);
      return new Response(`ok`);
    });
  }

  mock();

  await it.step("no cache", async () => {
    const ajax = new Ajax();

    const a1 = ajax.all_ajax({
      url: "http://localhost/test",
      method: "GET",
    });
    assertEquals(callStacks, [2]);

    assert(!a1.isFromMemoryCache);

    await a1.promise;
    assert(!a1.isFromMemoryCache);

    callStacks.length = 0;
  });

  await it.step("cached from memory", async () => {
    const ajax = new Ajax();

    const a1 = ajax.all_ajax({
      url: "http://localhost/test",
      method: "GET",
    });
    assertEquals(callStacks, [2]);

    assert(!a1.isFromMemoryCache);

    const a2 = ajax.all_ajax({
      url: "http://localhost/test",
      method: "GET",
    });
    assertEquals(callStacks, [2]);
    assert(a2.isFromMemoryCache);
    assert(a1 === a2);

    await a1.promise;
    await a2.promise;
    assert(a1 === a2);

    callStacks.length = 0;
  });

  await it.step("cached from memory, test long time", async () => {
    const ajax = new Ajax();

    const a1 = ajax.all_ajax({
      url: "http://localhost/test",
      method: "GET",
      cacheTimeout: 5_000, // 5s
    });
    assertEquals(callStacks, [2]);

    assert(!a1.isFromMemoryCache);

    const a2 = ajax.all_ajax({
      url: "http://localhost/test",
      method: "GET",
      cacheTimeout: 5_000, // 5s
    });
    assertEquals(callStacks, [2]);
    assert(a2.isFromMemoryCache);
    assert(a1 === a2);

    await a1.promise;
    await a2.promise;
    assert(a1 === a2);

    await delay(2_000);
    const a3 = ajax.all_ajax({
      url: "http://localhost/test",
      method: "GET",
      cacheTimeout: 5_000, // 5s
    });
    assertEquals(callStacks, [2]);
    assert(a3.isFromMemoryCache);
    assert(a1 === a3);

    await delay(3_000);

    const a4 = ajax.all_ajax({
      url: "http://localhost/test",
      method: "GET",
      cacheTimeout: 1_000, // 1s
    });
    assertEquals(callStacks, [2, 2]);
    assert(!a4.isFromMemoryCache);

    await delay(1_000);

    callStacks.length = 0;
  });

  await it.step("cached from store", async () => {
    callStacks.length = 0;
    localStorage.clear();

    const ajax = new Ajax();
    const store = new LocalStore();

    const a1 = ajax.all_ajax({
      url: "http://localhost/test",
      method: "GET",
      cacheStore: store,
    });
    assertEquals(callStacks, []);
    assert(!a1.isFromMemoryCache);
    assert(!a1.isFromStoreCache);
    await a1.promise;

    const a2 = ajax.all_ajax({
      url: "http://localhost/test",
      method: "GET",
      cacheStore: store,
    });
    assertEquals(callStacks, [2]);
    assert(!a2.isFromMemoryCache);
    assert(a1 !== a2);

    await a2.promise;
    assert(a2.isFromStoreCache);
    assert(!a2.isFromMemoryCache);
    assert(!a1.isFromStoreCache);

    callStacks.length = 0;
  });
});
