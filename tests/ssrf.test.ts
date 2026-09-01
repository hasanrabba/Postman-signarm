import { describe, it, expect } from "vitest";
import { isBlockedIp, isBlockedHostname, normalizeHostname } from "../src/lib/ssrf";

describe("normalizeHostname", () => {
  it("strips IPv6 brackets", () => {
    expect(normalizeHostname("[::1]")).toBe("::1");
    expect(normalizeHostname("[::ffff:127.0.0.1]")).toBe("::ffff:127.0.0.1");
  });
  it("strips a single trailing dot and lowercases", () => {
    expect(normalizeHostname("LocalHost.")).toBe("localhost");
  });
});

describe("isBlockedIp — IPv4", () => {
  const blocked = [
    "127.0.0.1", "127.0.0.2", "127.1.2.3", "127.255.255.254", // whole /8
    "10.0.0.1", "10.255.255.255",
    "172.16.0.1", "172.31.255.255",
    "192.168.0.1", "192.168.255.255",
    "169.254.169.254",   // cloud metadata
    "0.0.0.0", "0.1.2.3",
    "100.64.0.1",        // CGNAT
    "192.0.0.1",         // IETF protocol assignments
    "198.18.0.1",        // benchmarking
    "224.0.0.1",         // multicast
    "255.255.255.255",
  ];
  for (const ip of blocked) {
    it(`blocks ${ip}`, () => expect(isBlockedIp(ip)).toBe(true));
  }

  const allowed = ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.15.0.1", "172.32.0.1", "11.0.0.1", "192.167.0.1", "100.63.0.1", "100.128.0.1"];
  for (const ip of allowed) {
    it(`allows public ${ip}`, () => expect(isBlockedIp(ip)).toBe(false));
  }
});

describe("isBlockedIp — IPv6", () => {
  const blocked = [
    "::1", "[::1]", "::", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1",
    "::ffff:127.0.0.1",   // IPv4-mapped loopback
    "[::ffff:127.0.0.1]",
    "::ffff:169.254.169.254",
    "::ffff:10.0.0.1",
    "64:ff9b::127.0.0.1", // NAT64-embedded loopback
    "fe80::1%eth0",       // zone id
  ];
  for (const ip of blocked) {
    it(`blocks ${ip}`, () => expect(isBlockedIp(ip)).toBe(true));
  }
  const allowed = ["2606:4700:4700::1111", "2001:4860:4860::8888", "::ffff:8.8.8.8"];
  for (const ip of allowed) {
    it(`allows public ${ip}`, () => expect(isBlockedIp(ip)).toBe(false));
  }
});

describe("isBlockedHostname", () => {
  for (const h of ["localhost", "LOCALHOST", "localhost.", "foo.localhost", "printer.local", "db.internal", "x.home.arpa", "127.0.0.2", "[::1]"]) {
    it(`blocks ${h}`, () => expect(isBlockedHostname(h)).toBe(true));
  }
  for (const h of ["example.com", "api.github.com", "8.8.8.8"]) {
    it(`allows ${h}`, () => expect(isBlockedHostname(h)).toBe(false));
  }
  it("does not block a public name that merely contains 'localhost'", () => {
    expect(isBlockedHostname("localhost.example.com")).toBe(false);
  });
});
