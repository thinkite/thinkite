import { describe, expect, it } from "vitest";
import { treePids, treePorts } from "./ports.ts";

const PS = `
    1     0
  100     1
  101   100
  102   101
  200     1
`;

// `lsof -nP -iTCP -sTCP:LISTEN -F pn`: a p line, then an n line per socket.
const LSOF = `p102
n*:5173
n[::1]:24678
p101
n127.0.0.1:5173
p200
n*:8787
p999
n*:9000
`;

describe("treePorts", () => {
  it("gives each root the ports of its whole tree, ascending, once", () => {
    expect(treePorts(PS, LSOF, [100, 200, 300])).toEqual(
      new Map([
        [100, [5173, 24678]],
        [200, [8787]],
        [300, []],
      ]),
    );
  });
});

describe("treePids", () => {
  it("gives the roots and all their descendants, once", () => {
    expect(treePids(PS, [100, 200, 101]).sort((a, b) => a - b)).toEqual([
      100, 101, 102, 200,
    ]);
  });
});
