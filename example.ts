import { Ajax, FetchError } from "./mod.ts";

// Ajax.defaults.baseURL = "/api";

export const ajax = new Ajax({
  baseURL: "/api",
});

ajax.interceptors.request.use(
  function (mergedConfig) {
    console.log("----request---");
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
    console.log("----response---");
    // return data.slice(0, 10);
    return data;
  },
  function (err: FetchError) {
    console.log("-----error", err.message, err);
    return Promise.reject(err);
  }
);

interface User {
  data: {
    content: string;
  };
}

for (let i = 0; i < 5; i++) {
  ajax
    .get<User>(
      "https://v2.jinrishici.com/one.json?client=browser-sdk/1.2&X-User-Token=lGD4mCOJ4%2FFdAnQPuXjqhvaUO0QTw6rh",
      null,
      {
        timeout: 1000,
        cacheTimeout: 10_000,
        // headers: {
        //   aa: "2",
        // },
        revalidateTime: 5000,
      }
    )
    .then((res) => console.log(res.data.content));
}

async function request(msg: string) {
  const res = await ajax.get<User>(
    "https://v2.jinrishici.com/one.json?client=browser-sdk/1.2&X-User-Token=lGD4mCOJ4%2FFdAnQPuXjqhvaUO0QTw6rh",
    {},
    {
      timeout: 1000,
    }
  );
  console.info(msg, res.data.content);
  return res;
}

setTimeout(() => {
  request("second");
}, 10_000);

setTimeout(() => {
  request("last");
}, 20_000);

// setTimeout(() => {
//   ajax.get<User>("http://localhost:1000", {
//     1: 1,
//   }, {
//     timeout: 100,
//     headers: {
//       aa: "2",
//     },
//   }).then((res) => console.log(res));
// }, 5000);
