// @flow
'use strict';
import type {
  TraversalContext,
  Node as INode,
  Graph as IGraph
} from '@parcel/types';

export type NodeId = string;

export type Edge = {
  from: NodeId,
  to: NodeId
};

type GraphUpdates<T> = {
  added: Graph<T>,
  removed: Graph<T>
};

export type GraphOpts<T> = {
  nodes?: Array<[NodeId, T]>,
  edges?: Array<Edge>,
  rootNodeId?: ?NodeId
};

export default class Graph<Node: INode> implements IGraph<Node> {
  nodes: Map<NodeId, Node>;
  edges: Set<Edge>;
  rootNodeId: ?NodeId;

  constructor(opts: GraphOpts<Node> = {}) {
    this.nodes = new Map(opts.nodes);
    this.edges = new Set(opts.edges);
    this.rootNodeId = opts.rootNodeId || null;
  }

  serialize(): GraphOpts<Node> {
    return {
      nodes: [...this.nodes],
      edges: [...this.edges],
      rootNodeId: this.rootNodeId
    };
  }

  addNode(node: Node) {
    this.nodes.set(node.id, node);
    return node;
  }

  hasNode(id: string) {
    return this.nodes.has(id);
  }

  getNode(id: string): ?Node {
    return this.nodes.get(id);
  }

  setRootNode(node: Node) {
    this.addNode(node);
    this.rootNodeId = node.id;
  }

  getRootNode(): ?Node {
    return this.rootNodeId ? this.getNode(this.rootNodeId) : null;
  }

  addEdge(edge: Edge) {
    this.edges.add(edge);
    return edge;
  }

  hasEdge(edge: Edge) {
    for (let e of this.edges) {
      if (edge.from == e.from && edge.to === e.to) {
        return true;
      }
    }

    return false;
  }

  getNodesConnectedTo(node: Node): Array<Node> {
    let edges = Array.from(this.edges).filter(edge => edge.to === node.id);
    return edges.map(edge => {
      // $FlowFixMe
      return this.nodes.get(edge.from);
    });
  }

  getNodesConnectedFrom(node: Node): Array<Node> {
    let edges = Array.from(this.edges).filter(edge => edge.from === node.id);
    return edges.map(edge => {
      // $FlowFixMe
      return this.nodes.get(edge.to);
    });
  }

  merge(graph: Graph<Node>) {
    for (let [, node] of graph.nodes) {
      this.addNode(node);
    }

    for (let edge of graph.edges) {
      this.addEdge(edge);
    }
  }

  // Removes node and any edges coming from that node
  removeNode(node: Node): this {
    let removed = new this.constructor();

    this.nodes.delete(node.id);
    removed.addNode(node);

    for (let edge of this.edges) {
      if (edge.from === node.id || edge.to === node.id) {
        removed.merge(this.removeEdge(edge));
      }
    }

    return removed;
  }

  removeEdges(node: Node): this {
    let removed = new this.constructor();

    for (let edge of this.edges) {
      if (edge.from === node.id) {
        removed.merge(this.removeEdge(edge));
      }
    }

    return removed;
  }

  // Removes edge and node the edge is to if the node is orphaned
  removeEdge(edge: Edge): this {
    let removed = new this.constructor();

    this.edges.delete(edge);
    removed.addEdge(edge);

    for (let [id, node] of this.nodes) {
      if (edge.to === id) {
        if (this.isOrphanedNode(node)) {
          removed.merge(this.removeNode(node));
        }
      }
    }

    return removed;
  }

  isOrphanedNode(node: Node) {
    for (let edge of this.edges) {
      if (edge.to === node.id) {
        return false;
      }
    }
    return true;
  }

  replaceNode(fromNode: Node, toNode: Node) {
    this.addNode(toNode);

    for (let edge of this.edges) {
      if (edge.to === fromNode.id) {
        this.addEdge({from: edge.from, to: toNode.id});
        this.edges.delete(edge);
      }
    }

    this.removeNode(fromNode);
  }

  // Update a node's downstream nodes making sure to prune any orphaned branches
  // Also keeps track of all added and removed edges and nodes
  replaceNodesConnectedTo(
    fromNode: Node,
    toNodes: Array<Node>
  ): GraphUpdates<Node> {
    let removed = new Graph();
    let added = new Graph();

    let edgesBefore = Array.from(this.edges).filter(
      edge => edge.from === fromNode.id
    );
    let edgesToRemove = edgesBefore;

    for (let toNode of toNodes) {
      let existingNode = this.getNode(toNode.id);
      if (!existingNode) {
        this.addNode(toNode);
        added.addNode(toNode);
      } else {
        existingNode.value = toNode.value;
      }

      edgesToRemove = edgesToRemove.filter(edge => edge.to !== toNode.id);

      let edge = {from: fromNode.id, to: toNode.id};
      if (!this.hasEdge(edge)) {
        this.addEdge(edge);
        added.addEdge(edge);
      }
    }

    for (let edge of edgesToRemove) {
      removed.merge(this.removeEdge(edge));
    }

    return {removed, added};
  }

  traverse(
    visit: (node: Node, context?: any, traversal: TraversalContext) => any,
    startNode: ?Node
  ) {
    return this.dfs({
      visit,
      startNode,
      getChildren: this.getNodesConnectedFrom.bind(this)
    });
  }

  traverseAncestors(
    startNode: Node,
    visit: (node: Node, context?: any, traversal: TraversalContext) => any
  ) {
    return this.dfs({
      visit,
      startNode,
      getChildren: this.getNodesConnectedTo.bind(this)
    });
  }

  dfs({
    visit,
    startNode,
    getChildren
  }: {
    visit(node: Node, context?: any, traversal: TraversalContext): any,
    getChildren(node: Node): Array<Node>,
    startNode?: ?Node
  }): ?Node {
    let root = startNode || this.getRootNode();
    if (!root) {
      return null;
    }

    let visited = new Set<Node>();
    let stopped = false;
    let skipped = false;
    let ctx: TraversalContext = {
      skipChildren() {
        skipped = true;
      },
      stop() {
        stopped = true;
      }
    };

    let walk = (node, context) => {
      visited.add(node);

      skipped = false;
      let newContext = visit(node, context, ctx);
      if (typeof newContext !== 'undefined') {
        context = newContext;
      }

      if (skipped) {
        return;
      }

      if (stopped) {
        return context;
      }

      for (let child of getChildren(node)) {
        if (visited.has(child)) {
          continue;
        }

        visited.add(child);
        let result = walk(child, context);
        if (stopped) {
          return result;
        }
      }
    };

    return walk(root);
  }

  bfs(visit: (node: Node) => ?boolean): ?Node {
    let root = this.getRootNode();
    if (!root) {
      return null;
    }

    let queue: Array<Node> = [root];
    let visited = new Set<Node>([root]);

    while (queue.length > 0) {
      let node = queue.shift();
      let stop = visit(node);
      if (stop === true) {
        return node;
      }

      for (let child of this.getNodesConnectedFrom(node)) {
        if (!visited.has(child)) {
          visited.add(child);
          queue.push(child);
        }
      }
    }

    return null;
  }

  getSubGraph(node: Node): this {
    let graph = new this.constructor();
    graph.setRootNode(node);

    this.traverse(node => {
      graph.addNode(node);

      let edges = Array.from(this.edges).filter(edge => edge.from === node.id);
      for (let edge of edges) {
        graph.addEdge(edge);
      }
    }, node);

    return graph;
  }

  findNodes(callback: (node: Node) => boolean): Array<Node> {
    return Array.from(this.nodes.values()).filter(callback);
  }
}
