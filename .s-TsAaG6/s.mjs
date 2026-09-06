import fetch, { FormData } from 'node-fetch';
const res = await fetch("http://127.0.0.1:8967/a", {
  "method": "POST",
  "headers": {
    "Content-Type": "application/x-www-form-urlencoded"
  },
  "body": ""
});
const text = await res.text();
console.log(res.status, text);