export const KG_ENTITY_TYPES = [
  'person',
  'project',
  'tool',
  'org',
  'place',
  'concept',
  'unknown',
];

export const KG_PREDICATES = [
  {
    id: 'works_on',
    subjectTypes: ['person', 'org'],
    objectTypes: ['project', 'tool', 'concept'],
    prototypes: [
      'Alice works on AuthService.',
      'Alice is working on AuthService.',
      'Alice calisiyor AuthService uzerinde.',
      'Alice travaille sur AuthService.',
      'Alice trabaja en AuthService.',
    ],
    endPrototypes: [
      'Alice no longer works on AuthService.',
      'Alice stopped working on AuthService.',
      'Alice artık AuthService üzerinde çalışmıyor.',
      'Alice quit working on AuthService.',
    ],
  },
  {
    id: 'uses',
    subjectTypes: ['person', 'org', 'project'],
    objectTypes: ['tool', 'project', 'concept'],
    prototypes: [
      'Alice uses Docker.',
      'This project uses Neo4j.',
      'Alice Docker kullanıyor.',
      'Ce projet utilise Neo4j.',
      'El proyecto usa Neo4j.',
    ],
    endPrototypes: [
      'Alice no longer uses Docker.',
      'This project stopped using Neo4j.',
      'Bu proje artık Neo4j kullanmıyor.',
    ],
  },
  {
    id: 'depends_on',
    subjectTypes: ['project', 'tool', 'concept'],
    objectTypes: ['project', 'tool', 'concept'],
    prototypes: [
      'AuthService depends on Redis.',
      'This system relies on PostgreSQL.',
      'Bu sistem Redis e bagli.',
      'Ce service depend de Redis.',
    ],
    endPrototypes: [
      'AuthService no longer depends on Redis.',
      'This system stopped relying on PostgreSQL.',
      'Bu sistem artık Redis e bağlı değil.',
    ],
  },
  {
    id: 'blocked_by',
    subjectTypes: ['person', 'project', 'org'],
    objectTypes: ['project', 'tool', 'concept'],
    prototypes: [
      'AuthService is blocked by a schema migration.',
      'Alice is blocked by an API key issue.',
      'Bu iş bir API anahtarı problemi yüzünden bloklu.',
      'Le projet est bloque par une migration.',
    ],
    endPrototypes: [
      'AuthService is no longer blocked by the migration.',
      'Alice is no longer blocked by the API key issue.',
      'Bu iş artık bloklu değil.',
    ],
  },
  {
    id: 'part_of',
    subjectTypes: ['project', 'tool', 'org', 'concept'],
    objectTypes: ['project', 'org', 'concept'],
    prototypes: [
      'AuthService is part of Platform.',
      'Redis is part of the stack.',
      'AuthService platformun bir parcasi.',
      'AuthService fait partie de Platform.',
    ],
    endPrototypes: [
      'AuthService is no longer part of Platform.',
      'AuthService artık platformun bir parçası değil.',
    ],
  },
  {
    id: 'prefers',
    subjectTypes: ['person', 'org'],
    objectTypes: ['tool', 'concept', 'project'],
    prototypes: [
      'Alice prefers TypeScript.',
      'The team prefers Docker Compose.',
      'Alice TypeScript tercih ediyor.',
      'L equipe prefere TypeScript.',
    ],
    endPrototypes: [
      'Alice no longer prefers TypeScript.',
      'The team stopped preferring Docker Compose.',
      'Ekip artık Docker Compose tercih etmiyor.',
    ],
  },
];

export function predicateAllowsTypes(predicate, subjectType, objectType) {
  const subjectOk =
    predicate.subjectTypes.includes(subjectType) ||
    predicate.subjectTypes.includes('unknown') ||
    subjectType === 'unknown';
  const objectOk =
    predicate.objectTypes.includes(objectType) ||
    predicate.objectTypes.includes('unknown') ||
    objectType === 'unknown';
  return subjectOk && objectOk;
}
