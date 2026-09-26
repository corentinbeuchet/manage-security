import http from 'k6/http';
import { check } from 'k6';

export const options = {
  vus: 20,            // 20 utilisateurs virtuels en parallèle
  duration: '20s',
  thresholds: {
    http_req_failed: ['rate<0.01'],     // moins de 1 % d'erreurs
    http_req_duration: ['p(95)<200'],   // 95 % des requêtes en moins de 200 ms
  },
};

export default function () {
  const res = http.get('http://localhost:8080/hello');
  check(res, { 'statut 200': (r) => r.status === 200 });
}
