import type { HandlerMap } from "../protocol";
import { chromeCallMethods } from "./chromeCall";
import { modsMethods } from "./mods";
import { netMethods } from "./net";
import { pageMethods } from "./page";
import { tabsMethods } from "./tabs";

export const handlers: HandlerMap = {
  ...tabsMethods,
  ...pageMethods,
  ...modsMethods,
  ...netMethods,
  ...chromeCallMethods,
};
