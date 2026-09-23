export function threadListParams(limit=100){
  return {limit,sortKey:"updated_at",sortDirection:"desc"};
}
