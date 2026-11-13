// An in-memory stand-in for gpui-kit elements: records children, props and handlers.
export function el(...made) {
  const data = { nodes: [], props: {}, made };
  let proxy;
  proxy = new Proxy(data, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === "then") return undefined;
      return (...args) => {
        if (key === "child") data.nodes.push(args[0]);
        else if (key === "children") data.nodes.push(...args[0]);
        else if (key === "when") { if (args[0]) args[1](proxy); }
        else if (key === "hover") args[0](el());
        else data.props[key] = args.length === 1 ? args[0] : args;
        return proxy;
      };
    },
  });
  return proxy;
}
