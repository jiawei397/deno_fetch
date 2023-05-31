import { Ajax, FetchError } from "./mod.ts";

// Ajax.defaults.baseURL = "/api";

export const ajax = new Ajax();

ajax.interceptors.request.use(function (mergedConfig) {
  console.log("----request---");
  mergedConfig.headers = mergedConfig.headers || {};
  mergedConfig.headers.token = "abcd";
  return mergedConfig;
}, function (err) {
  return Promise.reject(err);
});

// 响应拦截
ajax.interceptors.response.use(function (data) {
  console.log("----response---");
  // return data.slice(0, 10);
  return data;
}, function (err: FetchError) {
  console.log("-----error", err.message, err);
  return Promise.reject(err);
});

interface User {
  name: string;
}

// for (let i = 0; i < 5; i++) {
ajax.get<User>("http://localhost:1000", {
  1: 1,
}, {
  timeout: 100,
  headers: {
    aa: "2",
  },
}).then((res) => console.log(res));
// }

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
