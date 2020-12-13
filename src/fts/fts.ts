"use strict";

import Query from "./Query.ts";
import Trie from "./Trie.js";
import { MANDATORY } from "../correlations.ts";
import { isStopWord, stem, tokenize } from "./Stemmer.ts";
import { Document, InternalDocument, RawResult } from "../types.ts";
import { assertNotEquals } from "https://deno.land/std@0.80.0/testing/asserts.ts";

const MAX_MATCHES = 150;
const LOG_4_DIVISOR = 1.0 / Math.log2(4.0);

/**
 * Normalize URLs by chopping off trailing index.html components.
 * standard deviation of relevancy. Return that minimum relevancy score.
 * @param {String} url The input URL.
 * @return {String} The normalized URL.
 */
function normalizeURL(url: string): string {
  return url.replace(/\/index.html$/, "/");
}

function computeScore(
  match: Match,
  maxRelevancyScore: number,
  maxAuthorityScore: number,
): number {
  const normalizedRelevancyScore = match.relevancyScore / maxRelevancyScore + 1;
  const normalizedAuthorityScore = match.authorityScore / maxAuthorityScore + 1;
  return Math.log2(normalizedRelevancyScore) +
    (Math.log2(normalizedAuthorityScore) * LOG_4_DIVISOR);
}

/**
 * We want to penalize the final score of any matches that are in the bottom
 * standard deviation of relevancy. Return that minimum relevancy score.
 * @param {Match[]} matches The matches over which to compute a relevancy threshold.
 * @return {number} The relevancy threshold.
 */
function computeRelevancyThreshold(matches: Match[]): number {
  let meanScore = 0;
  for (const match of matches) {
    meanScore += match.relevancyScore;
  }
  meanScore /= matches.length;

  let sum = 0;
  for (const match of matches) {
    sum += (match.relevancyScore - meanScore) ** 2;
  }

  return Math.sqrt((1 / (matches.length - 1) * sum));
}

function capLength<T>(array: T[], maxLength: number): T[] {
  return array.length > maxLength ? array.slice(0, maxLength) : array;
}

function hits(
  matches: Match[],
  converganceThreshold: number,
  maxIterations: number,
): Match[] {
  let lastAuthorityNorm = 0;
  let lastHubNorm = 0;
  for (let i = 0; i < maxIterations; i += 1) {
    let authorityNorm = 0;
    // Update all authority scores
    for (const match of matches) {
      match.authorityScore = 0;
      for (const incomingMatch of match.incomingNeighbors) {
        match.authorityScore += incomingMatch.hubScore;
      }
      authorityNorm += match.authorityScore ** 2;
    }

    // Normalise the authority scores
    authorityNorm = Math.sqrt(authorityNorm);
    for (const match of matches) {
      match.authorityScore /= authorityNorm;
    }

    // Update all hub scores
    let hubNorm = 0;
    for (const match of matches) {
      match.hubScore = 0;
      for (const outgoingMatch of match.outgoingNeighbors) {
        match.hubScore += outgoingMatch.authorityScore;
      }
      hubNorm += match.hubScore ** 2;
    }

    // Normalise the hub scores
    hubNorm = Math.sqrt(hubNorm);
    for (const match of matches) {
      match.hubScore /= hubNorm;
    }

    if (
      Math.abs(authorityNorm - lastAuthorityNorm) < converganceThreshold &&
      Math.abs(hubNorm - lastHubNorm) < converganceThreshold
    ) {
      break;
    }

    lastAuthorityNorm = authorityNorm;
    lastHubNorm = hubNorm;
  }

  // Cut anything with zero relevancy
  matches = matches.filter((match) => match.relevancyScore > 0);

  // Compute statistics for score normalization
  let maxRelevancyScore = 0;
  let maxAuthorityScore = 0;
  const relevancyScoreThreshold = computeRelevancyThreshold(matches);
  for (const match of matches) {
    if (isNaN(match.authorityScore)) match.authorityScore = 1e-10;

    // Ignore anything with bad relevancy for the purposes of score normalization
    if (match.relevancyScore < relevancyScoreThreshold) continue;

    if (match.relevancyScore > maxRelevancyScore) {
      maxRelevancyScore = match.relevancyScore;
    }
    if (match.authorityScore > maxAuthorityScore) {
      maxAuthorityScore = match.authorityScore;
    }
  }

  // Compute the final ranking score
  for (const match of matches) {
    match.score = computeScore(match, maxRelevancyScore, maxAuthorityScore);

    // Penalize anything with especially poor relevancy
    if (match.relevancyScore < relevancyScoreThreshold * 2.5) {
      match.score -= (relevancyScoreThreshold / match.relevancyScore);
    }
  }

  matches = matches.sort((a, b) => {
    if (a.score < b.score) {
      return 1;
    }
    if (a.score > b.score) {
      return -1;
    }

    return 0;
  });

  return capLength(matches, MAX_MATCHES);
}

/* Yuanhua Lv and ChengXiang Zhai. 2011. Lower-bounding term frequency
 * normalization. In Proceedings of the 20th ACM international
 * conference on Information and knowledge management (CIKM '11), Bettina
 * Berendt, Arjen de Vries, Wenfei Fan, Craig Macdonald, Iadh Ounis, and
 * Ian Ruthven (Eds.). ACM, New York, NY, USA, 7-16. DOI: https://doi.org/10.1145/2063576.2063584
 */
function dirichletPlus(
  termFrequencyInQuery: number,
  termFrequencyInDoc: number,
  termProbabilityInLanguage: number,
  docLength: number,
  queryLength: number,
): number {
  const delta = 0.05;

  // In the range suggested by A Study of Smoothing Methods for Language Models
  // Applied to Ad Hoc Information Retrieval [Zhai, Lafferty]
  const mu = 2000;

  // In some fields, the query may never exist, making its probability 0.
  // This is... weird. Return 0 to avoid NaN since while dirichlet+
  // prefers rare words, a nonexistent word should probably be ignored.
  if (termProbabilityInLanguage === 0) return 0;

  let term2 = Math.log2(
    1 + (termFrequencyInDoc / (mu * termProbabilityInLanguage)),
  );
  term2 += Math.log2(1 + (delta / (mu * termProbabilityInLanguage)));

  const term3 = queryLength * Math.log2(mu / (docLength + mu));

  return (termFrequencyInQuery * term2) + term3;
}

class TermEntry {
  docs: number[];
  positions: Map<number, number[]>;
  timesAppeared: Map<string, number>;

  constructor() {
    this.docs = [];
    this.positions = new Map();
    this.timesAppeared = new Map();
  }

  register(propertyName: string, fieldName: string, docID: number): void {
    this.docs.push(docID);
    this.timesAppeared.set(
      `${fieldName} ${propertyName}`,
      (this.timesAppeared.get(fieldName) || 0) + 1,
    );
  }

  getTimesAppeared(propertyName: string, fieldName: string): number {
    return this.timesAppeared.get(`${fieldName} ${propertyName}`) || 0;
  }

  addTokenPosition(docID: number, tokenID: number): void {
    const positions = this.positions.get(docID);
    if (!positions) {
      this.positions.set(docID, [tokenID]);
    } else {
      positions.push(tokenID);
    }
  }
}

class DocumentEntry {
  propertyName: string;
  len: number;
  termFrequencies: Map<string, number>;

  constructor(
    propertyName: string,
    len: number,
    termFrequencies: Map<string, number>,
  ) {
    this.propertyName = propertyName;
    this.len = len;
    this.termFrequencies = termFrequencies;
  }
}

class Match {
  _id: number;
  relevancyScore: number;
  terms: Set<string> | null;
  score: number;
  authorityScore: number;
  hubScore: number;
  incomingNeighbors: Match[];
  outgoingNeighbors: Match[];

  constructor(
    docID: number,
    relevancyScore: number,
    initialTerms: Set<string> | null,
  ) {
    this._id = docID;
    this.relevancyScore = relevancyScore;
    this.terms = initialTerms;

    this.score = 0.0;
    this.authorityScore = 1.0;
    this.hubScore = 1.0;
    this.incomingNeighbors = [];
    this.outgoingNeighbors = [];
  }
}

class Field {
  name: string;
  weight: number;
  documents: Map<number, DocumentEntry>;
  totalTokensSeen: number;
  _lengthWeight: number | null;

  constructor(name: string, weight: number) {
    this.name = name;
    this.documents = new Map();
    this.weight = weight;
    this.totalTokensSeen = 0;

    this._lengthWeight = null;
  }

  /** Return the inverse average number of unique terms per document.
     * This makes no fscking sense, but is useful as a weighting factor
     * in my testing. */
  get lengthWeight() {
    if (!this._lengthWeight) {
      let nTerms = 0;
      for (const doc of this.documents.values()) {
        nTerms += doc.termFrequencies.size;
      }

      this._lengthWeight = this.documents.size / nTerms;
    }

    return this._lengthWeight;
  }
}

export class FTSIndex {
  fields: Field[];
  trie: Trie;
  terms: Map<string, TermEntry>;
  docID: number;
  termID: number;
  documentWeights: Map<number, number>;
  linkGraph: Map<string, string[]>;
  inverseLinkGraph: Map<string, string[]>;
  urlToId: Map<string, number>;
  idToUrl: Map<number, string>;
  incomingNeighbors: number[][];
  outgoingNeighbors: number[][];
  wordCorrelations: Map<string, [string, number][]>;

  constructor(fields: [string, number][]) {
    this.fields = fields.map((field) => new Field(field[0], field[1]));
    this.trie = new Trie();
    this.terms = new Map();
    this.docID = 0;
    this.termID = 0;
    this.documentWeights = new Map();

    this.linkGraph = new Map();
    this.inverseLinkGraph = new Map();
    this.urlToId = new Map();
    this.idToUrl = new Map();

    this.incomingNeighbors = [];
    this.outgoingNeighbors = [];

    this.wordCorrelations = new Map();
  }

  // word can be multiple tokens. synonym must be a single token.
  correlateWord(word: string, synonym: string, closeness: number): void {
    word = tokenize(word, false).map((w) => stem(w)).join(" ");
    synonym = stem(synonym);

    const correlationEntry = this.wordCorrelations.get(word);
    if (!correlationEntry) {
      this.wordCorrelations.set(word, [[synonym, closeness]]);
    } else {
      correlationEntry.push([synonym, closeness]);
    }
  }

  collectCorrelations(terms: string[]) {
    const stemmedTerms = new Map(terms.map((term) => [stem(term), 1]));

    for (let i = 0; i < terms.length; i += 1) {
      const pair = [stem(terms[i])];

      if (i < terms.length - 1) {
        pair.push(`${pair[0]} ${stem(terms[i + 1])}`);
      }

      for (const term of pair) {
        const correlations = this.wordCorrelations.get(term);
        if (!correlations) continue;

        for (const [correlation, weight] of correlations) {
          const newWeight = Math.max(
            stemmedTerms.get(correlation) || 0,
            weight,
          );
          stemmedTerms.set(correlation, newWeight);
        }
      }
    }

    return stemmedTerms;
  }

  add(propertyName: string, document: InternalDocument): number {
    const docID = this.docID;
    document._id = docID;

    if (document.links !== undefined && document.url !== undefined) {
      document.url = normalizeURL(document.url);

      this.linkGraph.set(document.url, document.links || []);
      for (let href of document.links || []) {
        href = normalizeURL(href);
        let incomingLinks = this.inverseLinkGraph.get(href);
        if (!incomingLinks) {
          incomingLinks = [];
          this.inverseLinkGraph.set(href, incomingLinks);
        }

        incomingLinks.push(document.url);
      }
      this.urlToId.set(document.url, document._id);
      this.idToUrl.set(document._id, document.url);
    }

    for (const field of this.fields) {
      field._lengthWeight = null;
      const termFrequencies = new Map();

      let text;
      if (field.name === "title") {
        text = document.title;
      } else if (field.name === "tags") {
        text = document.tags;
      } else if (field.name === "text") {
        text = document.text;
      } else if (field.name === "headings") {
        text = document.headings;
      }
      if (!text) continue;

      const tokens = tokenize(text, true);
      let numberOfTokens = 0;

      for (let token of tokens) {
        if (isStopWord(token)) continue;
        if (token.startsWith("%%")) {
          this.correlateWord(token.slice(2), token, 0.9);
        } else if (token.startsWith("$") || token.startsWith("%")) {
          this.correlateWord(token.slice(1), token, 0.9);
        } else {
          token = stem(token);
        }

        numberOfTokens += 1;
        this.termID += 1;

        let indexEntry = this.terms.get(token);
        if (!indexEntry) {
          indexEntry = new TermEntry();
          this.terms.set(token, indexEntry);
        }

        const count = termFrequencies.get(token) || 0;
        termFrequencies.set(token, count + 1);

        if (count === 0) {
          this.trie.insert(token, docID);
          indexEntry.register(propertyName, field.name, docID);
        }

        indexEntry.addTokenPosition(docID, this.termID);
      }

      // After each field, bump by one to prevent accidental adjacency.
      this.termID += 1;

      field.totalTokensSeen += numberOfTokens;
      field.documents.set(
        document._id,
        new DocumentEntry(propertyName, numberOfTokens, termFrequencies),
      );
    }

    this.documentWeights.set(docID, document.weight || 1);
    this.docID += 1;

    return document._id;
  }

  getNeighbors(baseSet: Map<number, Match>, match: Match): void {
    const url = this.idToUrl.get(match._id);
    if (!url) {
      return;
    }
    const links = this.linkGraph.get(url) || [];

    let incomingNeighbors = this.incomingNeighbors[match._id];
    let outgoingNeighbors = this.outgoingNeighbors[match._id];

    if (!incomingNeighbors) {
      const incomingNeighborsSet: Set<number> = new Set();
      for (const ancestorURL of this.inverseLinkGraph.get(url) || []) {
        const ancestorID = this.urlToId.get(ancestorURL);
        if (ancestorID === undefined) continue;

        if (ancestorID) {
          incomingNeighborsSet.add(ancestorID);
        }
      }

      incomingNeighbors = Array.from(incomingNeighborsSet);
      this.incomingNeighbors[match._id] = incomingNeighbors;
    }

    if (!outgoingNeighbors) {
      const outgoingNeighborsSet: Set<number> = new Set();
      for (const link of links) {
        const descendentID = this.urlToId.get(link);
        if (descendentID === undefined) continue;

        if (descendentID) {
          outgoingNeighborsSet.add(descendentID);
        }
      }

      outgoingNeighbors = Array.from(outgoingNeighborsSet);
      this.outgoingNeighbors[match._id] = outgoingNeighbors;
    }

    for (const neighborID of incomingNeighbors) {
      let newMatch = baseSet.get(neighborID);
      if (!newMatch) {
        newMatch = new Match(neighborID, 0, null);
        baseSet.set(neighborID, newMatch);
      }
      match.incomingNeighbors.push(newMatch);
    }

    for (const neighborID of outgoingNeighbors) {
      let newMatch = baseSet.get(neighborID);
      if (!newMatch) {
        newMatch = new Match(neighborID, 0, null);
        baseSet.set(neighborID, newMatch);
      }

      match.outgoingNeighbors.push(newMatch);
    }
  }

  collectMatchesFromTrie(terms: Iterable<string>): [number, string][] {
    const resultSet = [];
    for (const term of terms) {
      const matches = this.trie.search(term, true);
      for (const match of matches.entries()) {
        resultSet.push(match);
      }
    }

    return resultSet;
  }

  search(rawQuery: string | Query, useHits: boolean): Match[] {
    const query = (rawQuery instanceof Query) ? rawQuery : new Query(rawQuery);

    const matchSet = new Map();
    const originalTerms = new Set(query.terms);
    const stemmedTerms = this.collectCorrelations(Array.from(query.terms));

    for (const term of stemmedTerms.keys()) {
      const correlations = this.wordCorrelations.get(term);
      if (!correlations) continue;

      for (const [correlation, weight] of correlations) {
        const newWeight = Math.max(stemmedTerms.get(correlation) || 0, weight);
        stemmedTerms.set(correlation, newWeight);
      }
    }

    const mandatoryTerms = new Set(
      Array.from(query.terms).filter((term) => MANDATORY.has(term)).map(
        (term) => stem(term),
      ),
    );

    for (const tuple of this.collectMatchesFromTrie(stemmedTerms.keys())) {
      const [docID, terms] = tuple;
      if (!query.filter(docID)) continue;

      let match = matchSet.get(docID);
      if (!match) {
        match = new Match(docID, 0, new Set());
        matchSet.set(docID, match);
      }

      for (const term of terms) {
        const termEntry = this.terms.get(term);
        if (!termEntry) {
          continue;
        }

        let termRelevancyScore = 0;
        for (const field of this.fields) {
          const docEntry = field.documents.get(docID);
          if (!docEntry) continue;

          let termWeight = stemmedTerms.get(term) || 0.1;
          if (mandatoryTerms.has(term)) {
            termWeight *= 1.5;
          }
          const termFrequencyInDoc = docEntry.termFrequencies.get(term) || 0;
          const termProbability =
            termEntry.getTimesAppeared(docEntry.propertyName, field.name) /
            Math.max(field.totalTokensSeen, 500);
          const documentWeight = this.documentWeights.get(docID) || 1;

          // Larger fields yield larger scores, but we want fields to have roughly
          // equal weight. field.lengthWeight is stupid, but yields good results.
          termRelevancyScore += dirichletPlus(
            termWeight,
            termFrequencyInDoc,
            termProbability,
            docEntry.len,
            originalTerms.size,
          ) * field.weight * field.lengthWeight * documentWeight;
        }

        match.relevancyScore += termRelevancyScore;
        match.terms.add(term);
      }
    }

    // Create a root set of the core relevant results
    let rootSet = Array.from(matchSet.values());
    if (query.phrases.length) {
      rootSet = rootSet.filter((match) => {
        const tokens = new Map();
        match.terms = Array.from(match.terms);
        for (const term of match.terms) {
          const termEntry = this.terms.get(term);
          if (!termEntry) return false;

          const positions = termEntry.positions.get(match._id);
          if (!positions) return false;

          tokens.set(term, positions);
        }
        return query.checkPhrases(tokens);
      });
    }

    if (!useHits) {
      rootSet = rootSet.sort((a, b) => {
        if (a.relevancyScore < b.relevancyScore) {
          return 1;
        }
        if (a.relevancyScore > b.relevancyScore) {
          return -1;
        }

        return 0;
      });

      return capLength(rootSet, MAX_MATCHES);
    }

    // Expand our root set's neighbors to create a base set: the set of all
    // relevant pages, as well as pages that link TO or are linked FROM those pages.
    const baseSet = new Map(rootSet.map((match) => [match._id, match]));
    for (const match of rootSet) {
      this.getNeighbors(baseSet, match);
    }

    // Run HITS to re-sort our results based on authority
    return hits(Array.from(baseSet.values()), 0.00001, 200);
  }
}
