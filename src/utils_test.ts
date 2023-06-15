// Copyright 2018-2021 the oak authors. All rights reserved. MIT license.
import { assert, assertEquals } from "../test_deps.ts";
import { deleteUndefinedProperty, jsonParse } from "./utils.ts";

const { test } = Deno;

test({
  name: "jsonParse",
  fn() {
    assertEquals(jsonParse("a"), "a");
    assertEquals(jsonParse("1"), 1);
    assertEquals(jsonParse(true), true);
    assertEquals(jsonParse(false), false);
    assertEquals(jsonParse(1), 1);
    assertEquals(jsonParse({}), {});
    assertEquals(jsonParse([]), []);
    assertEquals(jsonParse(["a", "b"]), ["a", "b"]);
    assertEquals(jsonParse(`{"a":"b"}`), { a: "b" });
  },
});

test({
  name: "deleteUndefinedProperty",
  fn() {
    const obj = {
      a: "b",
      c: undefined,
      d: null,
      e: false,
      f: "",
    };
    deleteUndefinedProperty(obj);

    assert(obj.a === "b");
    assertEquals(obj, { a: "b", d: null, e: false, f: "" });
  },
});
