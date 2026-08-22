// Real-world shape: validating a submission against a schema-ish rule set.
function workload(input) {
  var form = input.form;
  var errors = [];
  if (!form.email || form.email.indexOf("@") < 0) errors.push("email");
  if (!form.username || form.username.length < 3 || form.username.length > 20) errors.push("username");
  if (!form.age || form.age < 18 || form.age > 120) errors.push("age");
  if (!form.password || form.password.length < 8) errors.push("password");
  if (form.password !== form.confirm) errors.push("confirm");
  var numbers = [];
  for (var i = 0; i < input.phones.length; i++) {
    var phone = String(input.phones[i]);
    if (/^1[3-9][0-9]{9}$/.test(phone)) numbers.push(phone);
  }
  if (!numbers.length) errors.push("phone");
  return { valid: errors.length === 0, errors: errors, numbers: numbers };
}
