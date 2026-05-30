// Grade ladder — kept in sync with v1 domain/user/grade.go. A user at a
// higher rank satisfies a level's min_grade requirement (it's a floor,
// not an equality check).
const GRADES = ['SO', 'SSO', 'ADO', 'DO', 'SDO', 'ADD', 'DDGFS', 'DGFS'];
const RANK: Record<string, number> = Object.fromEntries(
  GRADES.map((g, i) => [g, (i + 1) * 10]),
);

export function gradeAtLeast(actual: string | undefined, required: string | undefined): boolean {
  if (!required) return true;
  return (RANK[actual ?? ''] ?? 0) >= (RANK[required] ?? 0);
}
