insert into core.profiles (user_id, full_name, role) values
  ('4a54ee52-5eb1-4e51-a059-70e0eb869794', 'Pankaj Pola', 'super_admin'),
  ('9fda3687-ac0b-411d-b0f6-ed7d75665f0a', 'Pankaj Pola (Regional Test)', 'regional_manager'),
  ('5fc1f66e-622e-4c84-96a4-dfa30078ad9c', 'Pankaj Pola (EBO Test)', 'ebo_manager');

insert into core.user_store_access (user_id, store_id) values
  ('9fda3687-ac0b-411d-b0f6-ed7d75665f0a', 'BO-001'),
  ('9fda3687-ac0b-411d-b0f6-ed7d75665f0a', 'BO-003'),
  ('5fc1f66e-622e-4c84-96a4-dfa30078ad9c', 'BO-001');
